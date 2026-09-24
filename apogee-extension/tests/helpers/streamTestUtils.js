export function createCollectingPort({ throwOnPost = false } = {}) {
  const messages = [];
  return {
    messages,
    postMessage(msg) {
      if (throwOnPost) {
        throw new Error("Port disconnected");
      }
      messages.push(msg);
    },
    disconnect() {},
  };
}

export function withMockPerformanceClock(fn) {
  const origNow = performance.now;
  let currentTime = 1000;
  performance.now = () => currentTime;
  const advanceClock = (ms) => {
    currentTime += ms;
  };

  try {
    return fn({ advanceClock });
  } finally {
    performance.now = origNow;
  }
}
