import { performance } from "node:perf_hooks";

import { AudioFeeder } from "../dist/audio-feeder.mjs";

const emittedAt = [];
const feeder = new AudioFeeder(
  16_000,
  1,
  320,
  () => emittedAt.push(performance.now()),
  "lavfi:sine=frequency=440:sample_rate=16000",
);

feeder.start();
await new Promise((resolve) => setTimeout(resolve, 2_000));
const stats = feeder.getStats();
feeder.stop();

const intervals = emittedAt.slice(1).map((value, index) => value - emittedAt[index]);
const averageIntervalMs = intervals.length
  ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
  : 0;

console.log(JSON.stringify({
  ...stats,
  averageIntervalMs: Number(averageIntervalMs.toFixed(2)),
}, null, 2));
