/**
 * Shared type definitions for baileys-caller.
 *
 * @author ShellTear
 */
/** Audio stream configuration reported by the WASM. */
export type AudioConfig = {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    framesPerChunk: number;
};
/** Processing applied to outbound file/lavfi audio before Opus encoding. */
export type AudioQuality = "voice" | "raw";
/** Minimum Baileys socket surface required by the VoIP signaling bridge. */
export type BaileysSocketLike = {
    authState: any;
    signalRepository: any;
    generateMessageTag: () => string;
    query: (node: any) => Promise<any>;
    sendNode: (node: any) => Promise<void>;
    waitForMessage: (tag: string, timeoutMs: number) => Promise<any>;
    getUSyncDevices: (jids: string[], ignoreZeroDevices: boolean, forceQuery: boolean) => Promise<any[]>;
    presenceSubscribe: (jid: string) => Promise<void>;
    ws: any;
    ev: any;
    end?: () => void;
};
/** Options for placing a call. */
export type CallOptions = {
    /** Phone number, digits only (e.g. `"12345678901"`). */
    to: string;
    /** Audio source: file path to MP3/WAV, or `"silence"` for an empty uplink. */
    audioSource?: string;
    /** `"voice"` improves speech clarity and level consistency; `"raw"` only resamples. */
    audioQuality?: AudioQuality;
    /** Auto-hangup after N ms (default: 120000). */
    durationMs?: number;
};
/** Events emitted by an `ActiveCall`. */
export type CallEvents = {
    ringing: () => void;
    connected: () => void;
    /** Negotiated remote PCM format. */
    audioConfig: (config: AudioConfig) => void;
    /** Float32 PCM frame from the remote peer using the negotiated audio config. */
    audio: (pcm: Float32Array) => void;
    /** Reason: `"hangup"` | `"timeout"` | `"rejected"` | `"remote_end"` | `"disconnect"` | etc. */
    ended: (reason: string) => void;
    error: (err: Error) => void;
};
/** Top-level SDK configuration. */
export type VoipSdkConfig = {
    /** Path to a Baileys multi-file auth state directory. Not needed with `socket`. */
    authDir?: string;
    /**
     * An already-connected Baileys socket. It remains owned by the caller and
     * will not be closed by `VoipClient.disconnect()`.
     */
    socket?: BaileysSocketLike;
    /** Receives client-level errors that happen outside an active call. */
    onError?: (err: Error) => void;
    /** WASM worker count. Defaults to at most 4; lower values use less memory. */
    pthreadPoolSize?: number;
    /** FFmpeg executable used for file/lavfi audio. Defaults to `"ffmpeg"`. */
    ffmpegPath?: string;
};
/** Mirrors the WhatsApp WASM `CallState` enum. */
export declare const CallState: {
    readonly Idle: 0;
    readonly Calling: 1;
    readonly PreacceptReceived: 2;
    readonly ReceivedCall: 3;
    readonly AcceptSent: 4;
    readonly AcceptReceived: 5;
    readonly Active: 6;
    readonly ActiveElsewhere: 7;
    readonly Ending: 13;
};
export type CallState = (typeof CallState)[keyof typeof CallState];
/** Relay list update payload from WASM call event 156. */
export type RelayListUpdate = {
    relay_key: string;
    relay_tokens: string[];
    auth_tokens?: string[];
    enable_edgeray_dtls_active_mode?: boolean;
    relays: ReadonlyArray<{
        relay_id: number;
        relay_name: string;
        token_id: number;
        auth_token_id?: number;
        addresses: ReadonlyArray<{
            protocol: number;
            ipv4?: string;
            ipv6?: string;
            port?: number;
            port_v6?: number;
        }>;
    }>;
};
