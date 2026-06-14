import type { AudioQuality } from "./types.mjs";
export declare class AudioFeeder {
    #private;
    private readonly sampleRate;
    private readonly channels;
    private readonly framesPerChunk;
    private readonly onChunk;
    private readonly source;
    private readonly onError?;
    private readonly audioQuality;
    private readonly ffmpegPath;
    droppedChunks: number;
    underflowChunks: number;
    bytesProduced: number;
    chunksEmitted: number;
    allocatedChunks: number;
    reusedChunks: number;
    constructor(sampleRate: number, channels: number, framesPerChunk: number, onChunk: (chunk: Float32Array) => void, source?: string, onError?: ((err: Error) => void) | undefined, audioQuality?: AudioQuality, ffmpegPath?: string);
    start: () => void;
    stop: () => void;
    getStats: () => {
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
    };
}
