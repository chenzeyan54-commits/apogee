// Fake extension port shared by the stream tests: collects posted messages
// for producer-side assertions (broadcast/replay) and emits inbound
// messages for consumer-side tests (attachToStream), replacing the
// per-file createFakePort duplicates.
export function createCollectingPort({ throwOnPost = false } = {}) {
  const messages = [];
  const listeners = { message: [], disconnect: [] };
  return {
    messages,
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    postMessage(msg) {
      if (throwOnPost) {
        throw new Error("Port disconnected");
      }
      messages.push(msg);
    },
    disconnect() {},
    _emitMessage: (msg) => listeners.message.forEach((fn) => fn(msg)),
    _emitDisconnect: () => listeners.disconnect.forEach((fn) => fn()),
  };
}

// Drain an async iterable (token stream, generator) into an array for
// assertions. Shared by the engine and summarize tests instead of a
// per-file copy.
export async function collectAsync(gen) {
  const out = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

// Canned chat-stream stub shared by the summarize and language tests:
// replays one output per call and records each invocation. Tolerates both
// lib call conventions — chatStreamFn(host, model, prompt, opts) in the
// summarize path and chatFn(prompt, opts) in the language path.
export function makeCannedChat(outputs) {
  const calls = [];
  async function* fn(...args) {
    const last = args[args.length - 1];
    const opts = last && typeof last === "object" ? last : {};
    const prompt = typeof args[0] === "string" ? args[0] : args[2];
    const isTranslate = String(prompt).startsWith(
      "You are a translation engine",
    );
    calls.push({ system: opts.system || null, isTranslate, prompt });
    yield outputs[calls.length - 1] ?? "out";
  }
  return { fn, calls };
}

export function withMockPerformanceClock(fn) {
  const origNow = performance.now;
  let currentTime = 1000;
  performance.now = () => currentTime;
  const advanceClock = (ms) => {
    currentTime += ms;
  };
  const restoreClock = () => {
    performance.now = origNow;
  };

  let result;
  try {
    result = fn({ advanceClock });
  } catch (err) {
    restoreClock();
    throw err;
  }
  // Keep the mock clock installed until async test bodies settle; otherwise
  // the real clock leaks into post-await assertions.
  if (result && typeof result.then === "function") {
    return result.finally(restoreClock);
  }
  restoreClock();
  return result;
}
