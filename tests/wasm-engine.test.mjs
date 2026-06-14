import assert from "node:assert/strict";
import test from "node:test";

import { WasmEngine } from "../dist/wasm-engine.mjs";

test("initializes and destroys the bundled WASM engine", { timeout: 60_000 }, async () => {
  const engine = new WasmEngine({
    enableLogs: false,
    callbacks: { onAudioPlaybackInit() {} },
  });
  try {
    await engine.initialize();
    assert.equal(engine.isInitialized(), true);
    assert.equal(engine.getRuntimeStats().pthreadPoolSize, 4);
    assert.equal(engine.getRuntimeStats().managedWorkers, 4);
    WasmEngine.notifyGlobalCallbackListeners("initPlaybackDriverJS", {
      sample_rate: 48_000,
      channels: 2,
      bits_per_sample: 32,
      frames_per_chunk: 480,
    });
    assert.equal(engine.getRuntimeStats().playbackSampleRate, 48_000);
    assert.equal(engine.getRuntimeStats().playbackChannels, 2);
    assert.equal(engine.getRuntimeStats().playbackFramesPerChunk, 480);
    const secondEngine = new WasmEngine({ enableLogs: false });
    await assert.rejects(secondEngine.initialize(), /Only one WasmEngine/);
  } finally {
    engine.destroy();
  }
  assert.equal(engine.isInitialized(), false);
});
