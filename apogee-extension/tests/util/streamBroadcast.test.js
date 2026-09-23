import test from "node:test";
import assert from "node:assert";

import { broadcastToStream } from "../../lib/util/streamBroadcast.js";
import { createStreamState } from "../../lib/util/streamState.js";

// The subscriber set must be copied before broadcast (#314): a port that
// disconnects mid-broadcast mutates `subscribers` via its onDisconnect
// handler, and iterating the live set would skip the next subscriber.

function createPort(log) {
  return {
    postMessage: (msg) => {
      log.push(msg);
    },
    disconnect: () => {},
  };
}

test("broadcast reaches every subscriber even when one unsubscribes mid-broadcast", () => {
  const stream = createStreamState();
  const received = [[], [], []];
  const ports = received.map((log) => createPort(log));
  // First port's delivery removes the second port, as an onDisconnect
  // handler would during a real disconnect.
  const origPost = ports[0].postMessage;
  ports[0].postMessage = (msg) => {
    origPost(msg);
    stream.subscribers.delete(ports[1]);
  };
  for (const port of ports) stream.subscribers.add(port);

  broadcastToStream(stream, { type: "chunk", text: "hello" });

  assert.strictEqual(received[0].length, 1, "first subscriber gets the chunk");
  assert.strictEqual(
    received[1].length,
    1,
    "removed-mid-broadcast subscriber still gets the in-flight chunk",
  );
  assert.strictEqual(
    received[2].length,
    1,
    "later subscribers are not skipped after a mid-broadcast removal",
  );
});

test("broadcast tolerates a throwing port and still delivers to the rest", () => {
  const stream = createStreamState();
  const good = [];
  stream.subscribers.add(createPort(good));
  stream.subscribers.add({
    postMessage: () => {
      throw new Error("dead port");
    },
    disconnect: () => {},
  });
  const good2 = [];
  stream.subscribers.add(createPort(good2));

  broadcastToStream(stream, { type: "done" });

  assert.strictEqual(good.length, 1);
  assert.strictEqual(good2.length, 1);
});
