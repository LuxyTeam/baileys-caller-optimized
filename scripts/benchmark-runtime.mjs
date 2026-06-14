import { performance } from "node:perf_hooks";

import { WasmEngine } from "../dist/wasm-engine.mjs";

const engine = new WasmEngine({ enableLogs: false });
const startedAt = performance.now();

try {
  await engine.initialize();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    initializeMs: Math.round(performance.now() - startedAt),
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    ...engine.getRuntimeStats(),
  }, null, 2));
} finally {
  engine.destroy();
}
