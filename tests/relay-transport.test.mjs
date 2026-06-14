import assert from "node:assert/strict";
import test from "node:test";

import { RelayRtcTransport } from "../dist/relay-transport.mjs";

test("reports relay connection health counters", () => {
  const relay = new RelayRtcTransport({ onTransportMessage() {} });

  assert.deepEqual(relay.getStats(), {
    sentPackets: 0,
    receivedPackets: 0,
    sentBytes: 0,
    receivedBytes: 0,
    droppedPackets: 0,
    openConnections: 0,
    failedConnections: 0,
  });
});
