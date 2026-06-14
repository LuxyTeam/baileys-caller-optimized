/**
 * Audio feeder.
 *
 * Spawns ffmpeg to decode `source` into f32le PCM at the requested rate, then
 * meters frames out at chunk-cadence to the WASM uplink.
 *
 * @author ShellTear
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
const TARGET_BUFFER_MS = 80;
const MAX_BUFFER_MS = 200;
const DEFAULT_WARMUP_MS = 250;
export class AudioFeeder {
    sampleRate;
    channels;
    framesPerChunk;
    onChunk;
    source;
    onError;
    #proc = null;
    #pending = Buffer.alloc(0);
    #queue = [];
    #reusableChunks = [];
    #silenceChunk = null;
    #emitTimer = null;
    #nextEmitAtMs = 0;
    #warmupUntilMs = 0;
    #stopped = true;
    #chunkIntervalMs = 20;
    #targetQueuedChunks = 4;
    #maxQueuedChunks = 10;
    #isSilenceSource = false;
    droppedChunks = 0;
    underflowChunks = 0;
    bytesProduced = 0;
    chunksEmitted = 0;
    allocatedChunks = 0;
    reusedChunks = 0;
    constructor(sampleRate, channels, framesPerChunk, onChunk, source = "silence", onError) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.framesPerChunk = framesPerChunk;
        this.onChunk = onChunk;
        this.source = source;
        this.onError = onError;
    }
    start = () => {
        if (!this.#stopped)
            return;
        this.#stopped = false;
        const chunkSamples = this.framesPerChunk * this.channels;
        const chunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        this.#chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;
        this.#targetQueuedChunks = Math.max(2, Math.ceil(TARGET_BUFFER_MS / this.#chunkIntervalMs));
        this.#maxQueuedChunks = Math.max(this.#targetQueuedChunks + 1, Math.ceil(MAX_BUFFER_MS / this.#chunkIntervalMs));
        this.#nextEmitAtMs = 0;
        this.#isSilenceSource = !this.source || this.source === "silence";
        if (this.#isSilenceSource) {
            this.#warmupUntilMs = 0;
            this.#scheduleNext(chunkSamples);
            return;
        }
        const inputArgs = this.#resolveInputArgs();
        const proc = spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel", "error",
            "-nostdin",
            "-threads", "1",
            "-thread_queue_size", "64",
            "-re",
            ...inputArgs,
            "-f", "f32le",
            "-ac", String(this.channels),
            "-ar", String(this.sampleRate),
            "pipe:1",
        ]);
        this.#proc = proc;
        proc.stdout.on("data", (chunk) => {
            this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
            while (this.#pending.length >= chunkBytes) {
                if (this.#queue.length >= this.#maxQueuedChunks) {
                    proc.stdout.pause();
                    break;
                }
                const frame = this.#pending.subarray(0, chunkBytes);
                this.#pending = this.#pending.subarray(chunkBytes);
                const reusable = this.#reusableChunks.pop();
                const out = reusable ?? new Float32Array(chunkSamples);
                if (reusable)
                    this.reusedChunks += 1;
                else
                    this.allocatedChunks += 1;
                out.set(new Float32Array(frame.buffer, frame.byteOffset, chunkSamples));
                this.bytesProduced += chunkBytes;
                this.#queue.push(out);
            }
            if (this.#pending.length === 0)
                this.#pending = Buffer.alloc(0);
        });
        proc.stderr.on("data", (chunk) => {
            process.stderr.write(`[AudioFeeder] ${chunk.toString().trim()}\n`);
        });
        proc.on("error", (err) => {
            if (this.#proc === proc)
                this.#proc = null;
            if (!this.#stopped)
                this.onError?.(err);
        });
        proc.on("exit", (code) => {
            if (code !== 0 && code !== null) {
                const err = new Error(`ffmpeg exited with code=${code}`);
                process.stderr.write(`[AudioFeeder] ${err.message}\n`);
                if (!this.#stopped)
                    this.onError?.(err);
            }
            if (this.#proc === proc)
                this.#proc = null;
        });
        this.#warmupUntilMs = performance.now() + DEFAULT_WARMUP_MS;
        this.#scheduleNext(chunkSamples);
    };
    stop = () => {
        this.#stopped = true;
        this.#stopTimer();
        this.#proc?.kill("SIGTERM");
        this.#proc = null;
        this.#pending = Buffer.alloc(0);
        this.#queue = [];
        this.#reusableChunks = [];
        this.#silenceChunk = null;
        this.#isSilenceSource = false;
        this.#warmupUntilMs = 0;
    };
    #stopTimer = () => {
        if (!this.#emitTimer)
            return;
        clearTimeout(this.#emitTimer);
        this.#emitTimer = null;
    };
    #resolveInputArgs = () => {
        if (this.source.startsWith("lavfi:")) {
            return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
        }
        return ["-i", this.source];
    };
    #scheduleNext = (chunkSamples) => {
        if (this.#stopped)
            return;
        const now = performance.now();
        if (this.#nextEmitAtMs === 0)
            this.#nextEmitAtMs = now;
        const delayMs = Math.max(0, this.#nextEmitAtMs - now);
        this.#emitTimer = setTimeout(() => {
            this.#emitTimer = null;
            const currentTime = performance.now();
            if (this.#queue.length < this.#targetQueuedChunks && currentTime < this.#warmupUntilMs) {
                this.#nextEmitAtMs = currentTime + 5;
                this.#scheduleNext(chunkSamples);
                return;
            }
            this.#flushOne(chunkSamples);
            this.#nextEmitAtMs += this.#chunkIntervalMs;
            if (currentTime - this.#nextEmitAtMs > this.#chunkIntervalMs) {
                this.#nextEmitAtMs = currentTime + this.#chunkIntervalMs;
            }
            this.#scheduleNext(chunkSamples);
        }, delayMs);
        this.#emitTimer.unref?.();
    };
    #flushOne = (chunkSamples) => {
        let nextChunk = this.#queue.shift();
        const reusable = nextChunk;
        if (!nextChunk) {
            if (!this.#silenceChunk) {
                this.#silenceChunk = new Float32Array(chunkSamples);
                this.allocatedChunks += 1;
            }
            nextChunk = this.#silenceChunk;
            if (!this.#isSilenceSource)
                this.underflowChunks += 1;
        }
        this.chunksEmitted += 1;
        try {
            this.onChunk(nextChunk);
        }
        catch (err) {
            this.onError?.(err instanceof Error ? err : new Error(String(err)));
            this.stop();
            return;
        }
        if (reusable && this.#reusableChunks.length < this.#maxQueuedChunks) {
            this.#reusableChunks.push(reusable);
        }
        if (this.#proc?.stdout.isPaused() && this.#queue.length <= this.#targetQueuedChunks) {
            this.#proc.stdout.resume();
        }
    };
    getStats = () => ({
        queuedChunks: this.#queue.length,
        targetQueuedChunks: this.#targetQueuedChunks,
        maxQueuedChunks: this.#maxQueuedChunks,
        bufferMs: Math.round(this.#queue.length * this.#chunkIntervalMs),
        droppedChunks: this.droppedChunks,
        underflowChunks: this.underflowChunks,
        chunksEmitted: this.chunksEmitted,
        bytesProduced: this.bytesProduced,
        allocatedChunks: this.allocatedChunks,
        reusedChunks: this.reusedChunks,
    });
}
