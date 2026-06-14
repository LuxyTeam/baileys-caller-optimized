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
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { WasmEngine } from "./wasm-engine.mjs";
import { RelayRtcTransport } from "./relay-transport.mjs";
import { SignalingBridge } from "./signaling.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { CallState, } from "./types.mjs";
export { CallState } from "./types.mjs";
const SHA256_LEN = 32;
const loadBaileys = async () => {
    try {
        return await import("@whiskeysockets/baileys");
    }
    catch {
        throw new Error("Could not import @whiskeysockets/baileys. Install it as a peer dependency.");
    }
};
const toBareJid = (jid) => {
    if (!jid)
        return jid;
    const at = jid.indexOf("@");
    if (at < 0)
        return jid;
    const user = jid.slice(0, at).split(":")[0];
    return `${user}@${jid.slice(at + 1)}`;
};
const computeHkdf = (key, salt, info, length) => {
    const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
    const prk = createHmac("sha256", effectiveSalt).update(key).digest();
    const blocks = Math.ceil(length / SHA256_LEN);
    const okm = Buffer.alloc(blocks * SHA256_LEN);
    let prev = Buffer.alloc(0);
    for (let i = 1; i <= blocks; i += 1) {
        prev = createHmac("sha256", prk)
            .update(prev)
            .update(info)
            .update(Buffer.from([i]))
            .digest();
        prev.copy(okm, (i - 1) * SHA256_LEN);
    }
    return new Uint8Array(okm.buffer, okm.byteOffset, length);
};
const computeHmacSha256 = (data, key) => {
    const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};
const isCallReceiptNode = (node) => {
    if (node?.tag !== "receipt")
        return false;
    const child = Array.isArray(node.content) ? node.content[0] : null;
    return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};
/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
    callId;
    engine;
    #state = CallState.Idle;
    #endResolver;
    #endPromise;
    #endTimer = null;
    #ended = false;
    #audioConfig = null;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource = "silence";
    /** @internal outbound audio processing profile */
    _audioQuality = "voice";
    constructor(callId, engine, durationMs) {
        super();
        this.callId = callId;
        this.engine = engine;
        this.#endPromise = new Promise((res) => { this.#endResolver = res; });
        if (durationMs > 0) {
            this.#endTimer = setTimeout(() => this.#requestEnd("timeout"), durationMs);
            this.#endTimer.unref?.();
        }
    }
    get state() { return this.#state; }
    get ended() { return this.#ended; }
    get audioConfig() { return this.#audioConfig; }
    end = () => { this.#requestEnd("hangup"); };
    mute = (muted) => {
        if (this.#ended)
            return;
        try {
            this.engine.setMute(muted);
        }
        catch (err) {
            this._emitError(err);
        }
    };
    waitForEnd = () => this.#endPromise;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState = (state) => {
        this.#state = state;
        if (state === CallState.PreacceptReceived)
            this.emit("ringing");
        else if (state === CallState.Active)
            this.emit("connected");
        else if (state === CallState.Idle || state === CallState.Ending) {
            this._forceEnd("ended");
        }
    };
    /** @internal */
    _emitAudio = (pcm) => { this.emit("audio", pcm); };
    /** @internal */
    _updateAudioConfig = (config) => {
        this.#audioConfig = config;
        this.emit("audioConfig", config);
    };
    /** @internal */
    _emitError = (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.listenerCount("error") > 0)
            this.emit("error", error);
    };
    /** @internal */
    _forceEnd = (reason) => {
        if (this.#ended)
            return;
        this.#ended = true;
        this.#state = CallState.Idle;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        this.emit("ended", reason);
        this.#endResolver(reason);
    };
    #requestEnd = (reason) => {
        if (this.#ended)
            return;
        try {
            this.engine.endCall(0, true);
        }
        catch (err) {
            this._emitError(err);
        }
        finally {
            this._forceEnd(reason);
        }
    };
}
/** Top-level client. Connects to WhatsApp and lets you place calls. */
export class VoipClient {
    #config;
    #engine = null;
    #relay = null;
    #signaling = null;
    #sock = null;
    #activeCall = null;
    #baileys = null;
    #ownsSocket = false;
    #socketListenerDisposers = [];
    // Capture state populated when WASM negotiates audio params
    #capturePtr = 0;
    #captureChunkBytes = 0;
    #captureSampleRate = 16000;
    #captureChannels = 1;
    #captureFramesPerChunk = 320;
    #feeder = null;
    constructor(config) {
        this.#config = config;
    }
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect = async () => {
        if (this.#sock || this.#engine)
            throw new Error("Client is already connected.");
        try {
            await this.#connectInternal();
        }
        catch (err) {
            this.disconnect();
            throw err;
        }
    };
    #connectInternal = async () => {
        this.#baileys = await loadBaileys();
        if (this.#config.socket) {
            this.#validateExternalSocket(this.#config.socket);
            this.#sock = this.#config.socket;
            this.#ownsSocket = false;
        }
        else {
            await this.#createAndConnectSocket();
        }
        await this.#initializeVoip();
    };
    #createAndConnectSocket = async () => {
        const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
        const makeSocket = makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;
        if (!this.#config.authDir) {
            throw new Error("Provide either authDir or an already-connected Baileys socket.");
        }
        const authDir = resolve(this.#config.authDir);
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const silentLogger = {
            level: "silent",
            child: () => silentLogger,
            trace: () => { },
            debug: () => { },
            info: () => { },
            warn: () => { },
            error: () => { },
            fatal: () => { },
        };
        const createSocket = () => makeSocket({
            auth: state,
            emitOwnEvents: true,
            logger: silentLogger,
        });
        // Connect with auto-reconnect on the post-QR 515 stream-error path.
        await new Promise((resolveOpen, rejectOpen) => {
            let opened = false;
            let retries = 0;
            let retryTimer = null;
            const maxRetries = 5;
            const scheduleReconnect = (delayMs) => {
                if (opened || retryTimer || retries >= maxRetries)
                    return;
                retries += 1;
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    connectSocket();
                }, delayMs);
            };
            const connectSocket = () => {
                if (opened)
                    return;
                try {
                    this.#sock?.end?.();
                }
                catch { }
                const socket = createSocket();
                this.#sock = socket;
                this.#ownsSocket = true;
                socket.ev.on("creds.update", saveCreds);
                socket.ev.on("connection.update", (update) => {
                    if (this.#sock !== socket)
                        return;
                    if (update.qr) {
                        void import("qrcode-terminal")
                            .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
                            .catch(() => {
                            console.log("Scan this QR code in WhatsApp > Linked Devices:");
                            console.log(update.qr);
                        });
                    }
                    if (update.connection === "open") {
                        opened = true;
                        if (retryTimer) {
                            clearTimeout(retryTimer);
                            retryTimer = null;
                        }
                        resolveOpen();
                        return;
                    }
                    if (update.connection === "close") {
                        const error = update.lastDisconnect?.error ?? new Error("WhatsApp socket closed");
                        if (opened) {
                            this.#handleError(error);
                            this.disconnect();
                            return;
                        }
                        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
                        const shouldReconnect = statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
                        if (shouldReconnect && retries < maxRetries) {
                            scheduleReconnect(1000);
                        }
                        else {
                            rejectOpen(error);
                        }
                    }
                });
            };
            connectSocket();
        });
    };
    #initializeVoip = async () => {
        this.#signaling = new SignalingBridge({
            sock: this.#sock,
            onError: (err) => this.#handleError(err),
        });
        await this.#signaling.init();
        this.#relay = new RelayRtcTransport({
            onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
            onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
            // A relay list contains multiple candidates. One candidate failing must
            // not end a call while another candidate may still carry media.
            onError: (err) => this.#handleNonFatalError(err),
        });
        this.#engine = new WasmEngine({
            options: { pthreadPoolSize: this.#config.pthreadPoolSize },
            callbacks: {
                onSignalingXmpp: (peerJid, callId, xmlPayload) => this.#signaling.sendSignaling(peerJid, callId, xmlPayload),
                onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
                sendDataToRelay: (data, ip, port) => this.#relay.send(data, ip, port),
                onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
                onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
                onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
                onAudioPlaybackInit: (config) => this.#activeCall?._updateAudioConfig(config),
                shouldEmitAudioPlaybackData: () => (this.#activeCall?.listenerCount("audio") ?? 0) > 0,
                onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
                cryptoHkdf: computeHkdf,
                hmacSha256: computeHmacSha256,
            },
        });
        await this.#engine.initialize();
        this.#signaling.attachEngine(this.#engine);
        const selfPnJid = this.#sock.authState.creds.me?.id;
        const selfLidJid = this.#sock.authState.creds.me?.lid;
        this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
        await this.#engine.waitForVoipStackReady();
        try {
            this.#engine.updateNetworkMedium(2, 0);
        }
        catch { }
        this.#addSocketListener("CB:call", (node) => {
            this.#signaling.processIncomingCall(node, this.#engine, this.#activeCall?.callId ?? "");
        });
        this.#addSocketListener("CB:receipt", (node) => {
            if (!isCallReceiptNode(node))
                return;
            this.#signaling.processIncomingReceipt(node, this.#engine, this.#activeCall?.callId ?? "");
        });
    };
    #validateExternalSocket = (socket) => {
        const socketRecord = socket;
        const missing = [
            "authState",
            "signalRepository",
            "generateMessageTag",
            "query",
            "sendNode",
            "waitForMessage",
            "getUSyncDevices",
            "presenceSubscribe",
            "ws",
        ].filter((key) => socketRecord[key] == null);
        if (missing.length) {
            throw new Error(`Invalid Baileys socket; missing: ${missing.join(", ")}`);
        }
        if (!socket.authState?.creds?.me?.id) {
            throw new Error("The provided Baileys socket is not authenticated or connected.");
        }
    };
    #addSocketListener = (event, listener) => {
        this.#sock.ws.on(event, listener);
        this.#socketListenerDisposers.push(() => {
            const ws = this.#sock?.ws;
            if (typeof ws?.off === "function")
                ws.off(event, listener);
            else if (typeof ws?.removeListener === "function")
                ws.removeListener(event, listener);
        });
    };
    /** Place an outbound voice call. */
    call = async (phoneNumber, opts = {}) => {
        if (!this.#engine || !this.#signaling)
            throw new Error("Not connected. Call connect() first.");
        if (this.#activeCall)
            throw new Error("A call is already active.");
        const targetNumber = phoneNumber.replace(/\D/g, "");
        if (!targetNumber)
            throw new Error("phoneNumber must contain at least one digit.");
        const targetPnJid = `${targetNumber}@s.whatsapp.net`;
        const durationMs = opts.durationMs ?? 120_000;
        if (!Number.isFinite(durationMs) || durationMs < 0) {
            throw new Error("durationMs must be a finite number greater than or equal to zero.");
        }
        const audioSource = opts.audioSource ?? "silence";
        const audioQuality = opts.audioQuality ?? "voice";
        if (audioQuality !== "voice" && audioQuality !== "raw") {
            throw new Error('audioQuality must be either "voice" or "raw".');
        }
        const peerLid = await this.#signaling.resolveLid(targetPnJid);
        if (!peerLid)
            throw new Error(`Could not resolve LID for ${targetPnJid}`);
        for (const jid of [targetPnJid, peerLid]) {
            try {
                await this.#sock.presenceSubscribe(jid);
            }
            catch { }
        }
        await new Promise((r) => setTimeout(r, 750));
        const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
        const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];
        await this.#signaling.ensureSessionsForPeers(deviceList);
        await new Promise((r) => setTimeout(r, 500));
        await this.#signaling.issueTcToken(peerLid);
        const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);
        const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();
        const call = new ActiveCall(callId, this.#engine, durationMs);
        call._audioSource = audioSource;
        call._audioQuality = audioQuality;
        this.#activeCall = call;
        call.once("ended", () => {
            if (this.#activeCall === call)
                this.#activeCall = null;
            this.#handleAudioCaptureStop();
        });
        try {
            this.#engine.startCall({
                peerJid: peerLid,
                peerPn: targetPnJid,
                peerList: deviceList,
                callId,
                isVideo: false,
                isLidCall: true,
                isFromDialer: false,
                extraData: tcToken,
            });
        }
        catch (err) {
            call._emitError(err);
            call._forceEnd("error");
            throw err;
        }
        return call;
    };
    /** Tear down the WhatsApp socket and release resources. */
    disconnect = () => {
        this.#activeCall?._forceEnd("disconnect");
        this.#activeCall = null;
        this.#handleAudioCaptureStop();
        this.#relay?.closeAll();
        this.#signaling?.dispose();
        this.#engine?.destroy();
        for (const dispose of this.#socketListenerDisposers.splice(0))
            dispose();
        const ownedSocket = this.#ownsSocket ? this.#sock : null;
        this.#ownsSocket = false;
        ownedSocket?.end?.();
        this.#engine = null;
        this.#relay = null;
        this.#signaling = null;
        this.#sock = null;
    };
    /** Runtime metrics useful for monitoring audio quality and resource usage. */
    getStats = () => ({
        connected: !!this.#engine && !!this.#sock,
        activeCallId: this.#activeCall?.callId ?? null,
        audio: this.#feeder?.getStats() ?? null,
        relay: this.#relay?.getStats() ?? null,
        wasm: this.#engine?.getRuntimeStats() ?? null,
    });
    // ─── private ──────────────────────────────────────────────────────────────
    #handleCallEvent = (eventType, eventData) => {
        if (eventType === 16 && eventData) {
            try {
                const parsed = JSON.parse(eventData);
                const info = parsed.call_info ?? parsed.callInfo ?? {};
                const callState = Number(info.call_state ?? info.callState ?? 0);
                this.#activeCall?._updateState(callState);
            }
            catch { }
        }
        else if (eventType === 156 && eventData) {
            try {
                const update = JSON.parse(eventData);
                this.#relay?.updateRelayList(update);
            }
            catch { }
        }
        else if (eventType === 2) {
            this.#activeCall?._forceEnd("remote_end");
        }
    };
    #handleAudioCaptureInit = (config) => {
        if (!this.#engine)
            return;
        this.#captureSampleRate = config.sampleRate || 16000;
        this.#captureChannels = config.channels || 1;
        this.#captureFramesPerChunk = config.framesPerChunk || 320;
        const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
        this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        if (this.#capturePtr) {
            try {
                this.#engine.free(this.#capturePtr);
            }
            catch { }
        }
        this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
    };
    #handleAudioCaptureStart = () => {
        if (!this.#engine || !this.#capturePtr)
            return;
        this.#feeder?.stop();
        const audioSource = this.#activeCall?._audioSource ?? "silence";
        const audioQuality = this.#activeCall?._audioQuality ?? "voice";
        this.#feeder = new AudioFeeder(this.#captureSampleRate, this.#captureChannels, this.#captureFramesPerChunk, (chunk) => {
            if (this.#engine && this.#capturePtr)
                this.#engine.sendAudioData(chunk, this.#capturePtr);
        }, audioSource, (err) => this.#handleError(err), audioQuality, this.#config.ffmpegPath);
        this.#feeder.start();
    };
    #handleAudioCaptureStop = () => {
        this.#feeder?.stop();
        this.#feeder = null;
        if (this.#engine && this.#capturePtr) {
            try {
                this.#engine.free(this.#capturePtr);
            }
            catch { }
            this.#capturePtr = 0;
        }
    };
    #handleError = (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.#activeCall) {
            this.#activeCall._emitError(error);
            this.#activeCall._forceEnd("error");
            return;
        }
        this.#config.onError?.(error);
    };
    #handleNonFatalError = (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.#activeCall)
            this.#activeCall._emitError(error);
        else
            this.#config.onError?.(error);
    };
}
