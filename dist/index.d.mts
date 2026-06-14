/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { WasmEngine } from "./wasm-engine.mjs";
import { CallState, type AudioConfig, type AudioQuality, type CallOptions, type VoipSdkConfig } from "./types.mjs";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig, AudioQuality, BaileysSocketLike, } from "./types.mjs";
export { CallState } from "./types.mjs";
/** A live or recently-ended call. */
export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource: string;
    /** @internal outbound audio processing profile */
    _audioQuality: AudioQuality;
    constructor(callId: string, engine: WasmEngine, durationMs: number);
    get state(): CallState;
    get ended(): boolean;
    get audioConfig(): AudioConfig | null;
    end: () => void;
    mute: (muted: boolean) => void;
    waitForEnd: () => Promise<string>;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState: (state: number) => void;
    /** @internal */
    _emitAudio: (pcm: Float32Array) => void;
    /** @internal */
    _updateAudioConfig: (config: AudioConfig) => void;
    /** @internal */
    _emitError: (err: unknown) => void;
    /** @internal */
    _forceEnd: (reason: string) => void;
}
/** Top-level client. Connects to WhatsApp and lets you place calls. */
export declare class VoipClient {
    #private;
    constructor(config: VoipSdkConfig);
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect: () => Promise<void>;
    /** Place an outbound voice call. */
    call: (phoneNumber: string, opts?: Omit<CallOptions, "to">) => Promise<ActiveCall>;
    /** Tear down the WhatsApp socket and release resources. */
    disconnect: () => void;
    /** Runtime metrics useful for monitoring audio quality and resource usage. */
    getStats: () => {
        connected: boolean;
        activeCallId: string | null;
        audio: {
            queuedChunks: number;
            targetQueuedChunks: number;
            maxQueuedChunks: number;
            bufferMs: number;
            droppedChunks: number;
            underflowChunks: number;
            chunksEmitted: number;
            bytesProduced: number;
            allocatedChunks: number;
            reusedChunks: number;
            audioQuality: AudioQuality;
        } | null;
        relay: import("./relay-transport.mjs").RelayTransportStats | null;
        wasm: {
            pthreadPoolSize: number;
            managedWorkers: number;
            wasmMemoryBytes: number;
            playbackSampleRate: number;
            playbackChannels: number;
            playbackFramesPerChunk: number;
            playbackFramesPolled: number;
            playbackFramesEmitted: number;
            playbackFramesSkipped: number;
        } | null;
    };
}
