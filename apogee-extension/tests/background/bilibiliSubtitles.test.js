import test from "node:test";
import assert from "node:assert";
import { createExtensionApiMock } from "../helpers/extensionApiMock.js";
import {
  MAX_BILIBILI_SUBTITLE_CHARS,
  MAX_BILIBILI_SUBTITLE_SEGMENTS,
} from "../../lib/extract/fileLimits.js";

const { chrome } = createExtensionApiMock({
  settings: {
    saveHistory: true,
  },
});
chrome.permissions = {
  contains: (_req, cb) => cb(true),
};
globalThis.chrome = chrome;

const { fetchBilibiliSubtitlesWithStatus } =
  await import("../../background/service-worker.js");

const ARGS = { aid: "12345", cid: "67890", preferredLang: "en" };
const TRACK_URL = "https://xy123.hdslb.com/track.json";

// Exact hostname match: a substring check here would treat an attacker's
// api.bilibili.com.evil.example as the first-party metadata endpoint.
function isMetadataRequest(url) {
  try {
    return new URL(String(url)).hostname === "api.bilibili.com";
  } catch {
    return false;
  }
}

function mockFetch(trackBody) {
  return async (url) => {
    const payload = isMetadataRequest(url)
      ? {
          data: {
            subtitle: { subtitles: [{ lan: "en", subtitle_url: TRACK_URL }] },
          },
        }
      : { body: trackBody };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

function seg(i) {
  return { from: i * 2.5, content: ` hello  world ${i} ` };
}

test("fetchBilibiliSubtitlesWithStatus normalizes small tracks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch([seg(0), seg(1), { from: 5, content: "   " }]);
  try {
    const { segments: result, status } =
      await fetchBilibiliSubtitlesWithStatus(ARGS);
    assert.strictEqual(status, "ok");
    assert.deepStrictEqual(result, [
      { start: 0, text: "hello world 0" },
      { start: 2.5, text: "hello world 1" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchBilibiliSubtitlesWithStatus caps runaway segment counts", async () => {
  assert.strictEqual(MAX_BILIBILI_SUBTITLE_SEGMENTS, 5000);
  const originalFetch = globalThis.fetch;
  const oversized = Array.from(
    { length: MAX_BILIBILI_SUBTITLE_SEGMENTS + 1000 },
    (_, i) => seg(i),
  );
  globalThis.fetch = mockFetch(oversized);
  try {
    const { segments: result } = await fetchBilibiliSubtitlesWithStatus(ARGS);
    assert.strictEqual(result.length, MAX_BILIBILI_SUBTITLE_SEGMENTS);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchBilibiliSubtitlesWithStatus caps total characters", async () => {
  assert.strictEqual(MAX_BILIBILI_SUBTITLE_CHARS, 500 * 1024);
  const originalFetch = globalThis.fetch;
  const big = Array.from({ length: 100 }, (_, i) => ({
    from: i,
    content: "x".repeat(10 * 1024),
  }));
  globalThis.fetch = mockFetch(big);
  try {
    const { segments: result } = await fetchBilibiliSubtitlesWithStatus(ARGS);
    const total = result.reduce((n, s) => n + s.text.length, 0);
    assert.ok(total <= MAX_BILIBILI_SUBTITLE_CHARS);
    assert.ok(result.length < big.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchBilibiliSubtitlesWithStatus rejects invalid input without fetching", async () => {
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetched++;
    return originalFetch(...args);
  };
  try {
    assert.deepStrictEqual(await fetchBilibiliSubtitlesWithStatus({}), {
      segments: [],
      status: "invalid",
    });
    assert.deepStrictEqual(
      await fetchBilibiliSubtitlesWithStatus({
        aid: "1",
        cid: "not-a-number",
      }),
      { segments: [], status: "invalid" },
    );
    assert.strictEqual(fetched, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchBilibiliSubtitlesWithStatus distinguishes denied vs network vs empty (#306)", async () => {
  // Denied: host permission missing.
  const originalContains = chrome.permissions.contains;
  chrome.permissions.contains = (_req, cb) => cb(false);
  try {
    const denied = await fetchBilibiliSubtitlesWithStatus(ARGS);
    assert.deepStrictEqual(denied, { segments: [], status: "denied" });
  } finally {
    chrome.permissions.contains = originalContains;
  }

  // Network: permission granted but the metadata fetch throws.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    const network = await fetchBilibiliSubtitlesWithStatus(ARGS);
    assert.deepStrictEqual(network, {
      segments: [],
      status: "network-error",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Empty: reachable API with no subtitles for this video.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { subtitle: { subtitles: [] } } }), {
      status: 200,
    });
  try {
    const empty = await fetchBilibiliSubtitlesWithStatus(ARGS);
    assert.deepStrictEqual(empty, { segments: [], status: "empty" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
