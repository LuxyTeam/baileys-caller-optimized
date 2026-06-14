import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { VoipClient } from "../dist/index.mjs";

test("reuses an external Baileys socket without closing it", { timeout: 25_000 }, async () => {
  const ws = new EventEmitter();
  const ev = new EventEmitter();
  let endCalls = 0;
  const keyStore = new Map();
  const socket = {
    authState: {
      creds: {
        me: {
          id: "10000000000:1@s.whatsapp.net",
          lid: "10000000000:1@lid",
        },
      },
      keys: {
        async get(type, ids) {
          return Object.fromEntries(ids.map((id) => [id, keyStore.get(`${type}:${id}`)]));
        },
        async set(data) {
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              keyStore.set(`${type}:${id}`, value);
            }
          }
        },
      },
    },
    signalRepository: {},
    generateMessageTag: () => "test-tag",
    query: async () => ({}),
    sendNode: async () => {},
    waitForMessage: async () => ({}),
    getUSyncDevices: async () => [],
    presenceSubscribe: async () => {},
    ws,
    ev,
    end: () => { endCalls += 1; },
  };

  const client = new VoipClient({ socket, pthreadPoolSize: 4 });
  await client.connect();
  assert.equal(client.getStats().connected, true);
  assert.equal(ws.listenerCount("CB:call"), 1);
  assert.equal(ws.listenerCount("CB:receipt"), 1);

  client.disconnect();

  assert.equal(endCalls, 0);
  assert.equal(ws.listenerCount("CB:call"), 0);
  assert.equal(ws.listenerCount("CB:receipt"), 0);
});
