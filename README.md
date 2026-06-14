# baileys-caller

Place outbound WhatsApp voice calls from Node.js.

`baileys-caller` uses Baileys for authentication and signaling, WhatsApp
Web's VoIP WASM stack for Opus/RTP/SRTP, WebRTC data channels for relay
transport, and optional `ffmpeg` decoding for audio files.

This optimized edition is maintained by **Starsky**.

> This project depends on private WhatsApp Web internals. A WhatsApp update can
> require refreshing the bundled WASM resources or adapting the bridge.

## Changes by Starsky

- Reduced the default WASM worker pool from 20 to 4, cutting measured RSS
  memory usage by approximately 63%.
- Reworked outbound audio streaming with bounded buffering, reusable PCM
  chunks, monotonic timing, and drift correction.
- Added a speech-focused DSP profile with high-quality resampling, voice-band
  filtering, compression, and peak limiting before Opus encoding.
- Added support for reusing an already-connected Baileys socket without
  scanning another QR code or closing the shared connection.
- Improved inbound audio polling and avoided unnecessary PCM copies when no
  audio listener is attached.
- Added reliable call cleanup, sequential-call support, timeout handling,
  reconnect handling, and error propagation.
- Added runtime and audio metrics, benchmarks, regression tests, security
  auditing, and continuous integration.
- Updated dependencies and documentation for a more stable development and
  testing workflow.

## Status

- Outbound 1:1 voice calls
- MP3/WAV and `lavfi:` outbound audio sources
- Remote PCM audio as `Float32Array`
- Negotiated remote audio format through `audioConfig`
- Mute, unmute, timeout, and hang up
- Multiple sequential calls on one connected client
- Runtime audio, relay, worker, and memory metrics
- No group calls, video, or inbound call API

## Requirements

- Node.js 20 or newer
- `@whiskeysockets/baileys` 7.0.0-rc13 or newer compatible release
- A linked WhatsApp account
- `ffmpeg` on `PATH` only when streaming an audio file or `lavfi:` source

The default `"silence"` source is generated directly in Node.js and does not
start `ffmpeg`.

## Install

```bash
git clone https://github.com/LuxyTeam/baileys-caller-optimized
cd baileys-caller-optimized
npm install
npm run build
npm run check
```

To use it as a Git dependency:

```json
{
  "dependencies": {
    "baileys-caller": "git+https://github.com/LuxyTeam/baileys-caller-optimized.git",
    "@whiskeysockets/baileys": "^7.0.0-rc13"
  }
}
```

## Quick Start

```ts
import { VoipClient } from "baileys-caller";

const client = new VoipClient({
  authDir: "./auth",
  pthreadPoolSize: 4,
  onError: (err) => console.error("client error:", err),
});

await client.connect();

const call = await client.call("12345678901", {
  audioSource: "./hello.mp3",
  durationMs: 30_000,
});

call.on("ringing", () => console.log("ringing"));
call.on("connected", () => console.log("connected"));
call.on("audioConfig", (config) => console.log("remote PCM:", config));
call.on("audio", (pcm) => {
  // pcm uses call.audioConfig sample rate, channels, and frame size.
});
call.on("error", (err) => console.error("call error:", err));
call.on("ended", (reason) => console.log("ended:", reason));

console.log(await call.waitForEnd());
client.disconnect();
```

### Reuse an Existing Baileys Connection

When your application already has an authenticated and connected Baileys
socket, pass that same socket to `VoipClient`. No additional QR scan or second
WhatsApp connection is created:

```ts
import makeWASocket from "@whiskeysockets/baileys";
import { VoipClient } from "baileys-caller";

const sock = makeWASocket({
  auth: existingAuthState,
  // Your existing Baileys options...
});

// Wait for your normal Baileys connection.update event to report "open".
const voip = new VoipClient({
  socket: sock,
  pthreadPoolSize: 4,
});

await voip.connect(); // Initializes only the VoIP stack.

const call = await voip.call("12345678901", {
  audioSource: "./hello.wav",
  audioQuality: "voice",
});

await call.waitForEnd();
voip.disconnect(); // The shared `sock` remains connected.
```

The supplied socket must already be authenticated and connected. It must expose
the standard Baileys socket APIs, auth state, signal repository, and WebSocket
event emitter used by the VoIP signaling bridge.

Run the bundled example:

```bash
npx tsx examples/call.mts ./auth 12345678901 ./hello.mp3
```

## API

### `new VoipClient(options)`

| Option | Type | Description |
| --- | --- | --- |
| `authDir` | `string` | Baileys multi-file auth directory. Treat it as a credential. |
| `socket` | `Baileys socket?` | Existing authenticated and connected socket. Reused without taking ownership. |
| `pthreadPoolSize` | `number?` | WASM worker count. Defaults to at most 4. |
| `ffmpegPath` | `string?` | FFmpeg executable path. Defaults to the global `"ffmpeg"` command. |
| `onError` | `(err: Error) => void` | Errors that happen outside an active call. |

Provide either `authDir` or `socket`. When both are present, `socket` is used.
Only one `VoipClient`/WASM engine can be active in a Node.js process at once.

### `client.connect(): Promise<void>`

Connects Baileys and initializes the VoIP WASM runtime. The first connection
prints a QR code for WhatsApp Linked Devices.

### `client.call(phoneNumber, options?): Promise<ActiveCall>`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `audioSource` | `string` | `"silence"` | File path, `"silence"`, or a `lavfi:` expression. |
| `audioQuality` | `"voice" \| "raw"` | `"voice"` | Speech enhancement or resampling-only processing. |
| `durationMs` | `number` | `120000` | Automatic hang-up timeout. Use `0` to disable it. |

Only one call can be active at a time. After it ends, the same connected client
can place another call.

### `client.getStats()`

Returns current operational metrics:

```ts
const stats = client.getStats();

console.log(stats.audio?.bufferMs);
console.log(stats.audio?.underflowChunks);
console.log(stats.audio?.allocatedChunks);
console.log(stats.audio?.reusedChunks);
console.log(stats.relay?.droppedPackets);
console.log(stats.relay?.failedConnections);
console.log(stats.wasm?.managedWorkers);
console.log(stats.wasm?.wasmMemoryBytes);
console.log(stats.wasm?.playbackFramesSkipped);
```

Interpretation:

- `audio.bufferMs`: target is normally around 80 ms and is capped near 200 ms.
- `audio.underflowChunks`: should remain near zero for file sources.
- `audio.reusedChunks`: should increase during streaming, confirming buffer reuse.
- `relay.droppedPackets`: sustained increases indicate transport/network trouble.
- `relay.failedConnections`: failed relay candidates are reported but do not end
  the call while another candidate may still connect.
- `wasm.managedWorkers`: should match the configured pthread pool.
- `wasm.playbackFramesSkipped`: increases when no `audio` listener is attached,
  confirming that unnecessary PCM copies are being avoided.

### `client.disconnect(): void`

Ends the active call, stops audio, closes relay connections, terminates workers,
and releases the WASM runtime. An internally-created WhatsApp socket is closed;
a socket supplied through `socket` remains connected.

### `ActiveCall`

Events:

| Event | Payload | Description |
| --- | --- | --- |
| `ringing` | none | The remote device is ringing. |
| `connected` | none | The call became active. |
| `audioConfig` | `AudioConfig` | Negotiated PCM sample rate, channels, and frame size. |
| `audio` | `Float32Array` | Remote PCM frame using the negotiated format. |
| `error` | `Error` | Fatal call-related error. |
| `ended` | `string` | Final reason such as `hangup`, `timeout`, or `remote_end`. |

Methods and properties:

- `call.end()`
- `call.mute(muted)`
- `call.waitForEnd()`
- `call.callId`
- `call.state`
- `call.ended`
- `call.audioConfig`

## Audio Pipeline

Outbound file audio:

1. `ffmpeg` decodes and resamples the source to the format requested by WASM.
   Backpressure pauses decoding whenever the bounded queue is full.
2. The default `"voice"` profile applies high-quality resampling, an 80 Hz
   high-pass filter, a negotiated-rate low-pass filter, gentle compression,
   and peak limiting. Use `"raw"` for music or already-mastered audio.
3. A bounded queue keeps roughly 80 ms ready and never grows beyond about
   200 ms.
4. Reusable `Float32Array` buffers reduce per-frame allocations and garbage
   collection.
5. A monotonic clock sends frames at the exact negotiated frame cadence.
6. WASM encodes Opus and sends RTP/SRTP through the selected relay.

Inbound audio:

1. WASM decodes received Opus.
2. Playback polling follows the negotiated sample rate and frame size.
3. Drift correction prevents a fixed timer mismatch from accelerating or
   starving audio.
4. PCM is copied only when the application has an `audio` listener.

## Performance

The default worker pool is 4 instead of WhatsApp Web's browser-oriented pool
of 20. On the development machine used for this project:

| Pool | Approximate RSS | Initialization |
| ---: | ---: | ---: |
| 20 workers | 430 MB | 1.18 s |
| 4 workers | 160 MB | 0.79-0.96 s |

That is approximately 63% less RSS memory. Actual results depend on Node.js,
the OS, WASM resources, and active call behavior.

Choose a worker count conservatively:

```ts
const client = new VoipClient({
  authDir: "./auth",
  pthreadPoolSize: 4,
});
```

Or use an environment override:

```bash
CALL_WASM_PTHREAD_POOL_SIZE=4 node app.mjs
```

Use 4 as the normal starting point. Increase it only if real-call testing shows
worker exhaustion or audio stalls. Very low values may prevent the VoIP stack
from scheduling required native threads.

Run the local runtime benchmark:

```bash
npm run benchmark
npm run benchmark:audio
```

## Quality Checklist

For real-call validation:

1. Subscribe to `audioConfig` and play PCM using exactly that format.
2. Watch `audio.underflowChunks` and `relay.droppedPackets`.
3. Compare calls over stable Wi-Fi and wired connections.
4. Test both `"silence"` and a WAV/MP3 source.
5. Increase `pthreadPoolSize` only when metrics demonstrate a worker problem.
6. Do not perform heavy synchronous work inside the `audio` listener.

The SDK cannot guarantee a fixed percentage of perceptual quality improvement.
Network loss, relay selection, WhatsApp codec decisions, and the playback
device remain external factors.

## Development

```bash
npm run build       # compile source and worker bootstrap
npm test            # build and run regression tests
npm run check       # tests plus security audit
npm run benchmark   # initialize WASM and report runtime resource usage
npm run benchmark:audio # measure outbound buffering, reuse, and frame cadence
npm run fetch-wasm  # refresh resources from WhatsApp Web via Chrome CDP
```

CI runs tests and `npm audit --audit-level=high`.

## WASM Resources

Bundled resources live in `assets/wasm/`:

- `whatsapp.wasm`
- `worker-modules.js`
- `loader.js`

To refresh them, run Chrome with remote debugging, open WhatsApp Web, and run:

```bash
npm run fetch-wasm
```

## Security

- Treat `authDir` as a credential.
- Do not commit auth state, tokens, packet dumps, or `.env` files.
- Keep Baileys and the WASM resources current.
- Packet dumping can expose sensitive call metadata and payloads.

## License

MIT, ShellTear. Optimized edition maintained by Starsky.
