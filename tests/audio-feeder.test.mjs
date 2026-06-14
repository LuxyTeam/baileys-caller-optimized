import assert from "node:assert/strict";
import test from "node:test";

import { AudioFeeder } from "../dist/audio-feeder.mjs";

test("reports an unavailable ffmpeg executable", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const error = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("expected ffmpeg spawn error")), 2_000);
      const feeder = new AudioFeeder(16_000, 1, 320, () => {}, "lavfi:sine=440", (err) => {
        clearTimeout(timeout);
        feeder.stop();
        resolve(err);
      });
      feeder.start();
    });
    assert.match(error.message, /ffmpeg|ENOENT/i);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("uses an explicitly configured ffmpeg executable", async () => {
  const error = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("expected configured ffmpeg spawn error")), 2_000);
    const feeder = new AudioFeeder(
      16_000,
      1,
      320,
      () => {},
      "lavfi:sine=440",
      (err) => {
        clearTimeout(timeout);
        feeder.stop();
        resolve(err);
      },
      "voice",
      "definitely-missing-ffmpeg",
    );
    feeder.start();
  });

  assert.match(error.message, /definitely-missing-ffmpeg|ENOENT/i);
});

test("generates silence without spawning ffmpeg", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    let chunks = 0;
    const feeder = new AudioFeeder(16_000, 1, 320, (pcm) => {
      chunks += 1;
      assert.equal(pcm.some((sample) => sample !== 0), false);
    });
    feeder.start();
    feeder.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const stats = feeder.getStats();
    feeder.stop();
    assert.ok(chunks >= 2);
    assert.equal(stats.underflowChunks, 0);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("keeps the outbound buffer bounded and emits at frame cadence", { timeout: 5_000 }, async () => {
  const emittedAt = [];
  const feeder = new AudioFeeder(
    16_000,
    1,
    320,
    () => emittedAt.push(performance.now()),
    "lavfi:sine=frequency=440:sample_rate=16000",
  );
  feeder.start();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const stats = feeder.getStats();
  feeder.stop();

  assert.ok(stats.maxQueuedChunks <= 10);
  assert.ok(stats.bufferMs <= 200);
  assert.ok(stats.allocatedChunks <= stats.maxQueuedChunks + 2);
  assert.ok(stats.reusedChunks > 0);
  assert.ok(emittedAt.length >= 8);
  const intervals = emittedAt.slice(1).map((value, index) => value - emittedAt[index]);
  const averageInterval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  assert.ok(averageInterval >= 15 && averageInterval <= 25, `average=${averageInterval}`);
  assert.equal(stats.audioQuality, "voice");
});

test("supports raw audio without the voice enhancement profile", { timeout: 5_000 }, async () => {
  const feeder = new AudioFeeder(
    16_000,
    1,
    320,
    () => {},
    "lavfi:sine=frequency=440:sample_rate=16000",
    undefined,
    "raw",
  );
  feeder.start();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const stats = feeder.getStats();
  feeder.stop();

  assert.equal(stats.audioQuality, "raw");
  assert.ok(stats.chunksEmitted > 0);
});
