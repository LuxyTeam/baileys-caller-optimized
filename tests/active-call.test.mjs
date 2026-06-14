import assert from "node:assert/strict";
import test from "node:test";

import { ActiveCall } from "../dist/index.mjs";

const createEngine = (overrides = {}) => ({
  endCall() {},
  setMute() {},
  ...overrides,
});

test("end resolves waitForEnd and emits ended once", async () => {
  let endCalls = 0;
  const call = new ActiveCall("call-1", createEngine({
    endCall() { endCalls += 1; },
  }), 0);
  const reasons = [];
  call.on("ended", (reason) => reasons.push(reason));

  call.end();
  call.end();

  assert.equal(await call.waitForEnd(), "hangup");
  assert.equal(endCalls, 1);
  assert.deepEqual(reasons, ["hangup"]);
  assert.equal(call.ended, true);
});

test("duration timeout resolves with timeout reason", async () => {
  const call = new ActiveCall("call-2", createEngine(), 10);
  assert.equal(await call.waitForEnd(), "timeout");
});

test("mute reports engine errors without throwing", () => {
  const expected = new Error("mute failed");
  const call = new ActiveCall("call-3", createEngine({
    setMute() { throw expected; },
  }), 0);
  let received;
  call.on("error", (err) => { received = err; });

  call.mute(true);

  assert.equal(received, expected);
});

test("exposes the negotiated playback format", () => {
  const call = new ActiveCall("call-4", createEngine(), 0);
  const config = { sampleRate: 48_000, channels: 2, bitsPerSample: 32, framesPerChunk: 480 };
  let received;
  call.on("audioConfig", (value) => { received = value; });

  call._updateAudioConfig(config);

  assert.equal(received, config);
  assert.equal(call.audioConfig, config);
});
