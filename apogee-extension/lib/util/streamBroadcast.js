export function broadcastToStream(stream, msg) {
  // Copy the set: a port that disconnects mid-broadcast mutates
  // `subscribers` via its onDisconnect handler, and iterating the live set
  // would skip the next subscriber.
  for (const port of [...stream.subscribers]) {
    try {
      port.postMessage(msg);
    } catch {}
  }
}
