import test from "node:test";
import assert from "node:assert";
import { createExtensionApiMock } from "../helpers/extensionApiMock.js";

const { chrome } = createExtensionApiMock({
  settings: { useSponsorBlock: false },
});
chrome.permissions = {
  contains(_opts, callback) {
    callback(true);
  },
};
chrome.offscreen = {
  createDocument: async () => {},
  closeDocument: async () => {},
};
chrome.runtime.getContexts = async () => [
  { contextType: "OFFSCREEN_DOCUMENT" },
];
chrome.alarms = {
  create: () => {},
  clear: () => {},
};
globalThis.chrome = chrome;

const { fetchSponsorBlockSegmentsWithStatus } =
  await import("../../background/service-worker.js");

const VIDEO_ID = "dQw4w9WgXcQ";

async function segmentsFor(videoId) {
  const { segments } = await fetchSponsorBlockSegmentsWithStatus(videoId);
  return segments;
}

test("fetchSponsorBlockSegmentsWithStatus skips the lookup when Stay-fully-local is on", async () => {
  await chrome.storage.local.set({ settings: { useSponsorBlock: false } });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };
  try {
    assert.deepStrictEqual(await segmentsFor(VIDEO_ID), []);
    assert.strictEqual(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchSponsorBlockSegmentsWithStatus still serves lookups when the setting is on", async () => {
  await chrome.storage.local.set({ settings: { useSponsorBlock: true } });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => [
        {
          videoID: VIDEO_ID,
          segments: [
            { category: "sponsor", segment: [10, 20] },
            { category: "intro", segment: [0, 5] },
          ],
        },
      ],
    };
  };
  try {
    assert.deepStrictEqual(await segmentsFor(VIDEO_ID), [[10, 20]]);
    assert.strictEqual(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchSponsorBlockSegmentsWithStatus distinguishes off vs denied vs network vs empty (#306)", async () => {
  // Off: Stay-fully-local skips without fetching.
  await chrome.storage.local.set({ settings: { useSponsorBlock: false } });
  const off = await fetchSponsorBlockSegmentsWithStatus(VIDEO_ID);
  assert.deepStrictEqual(off, { segments: [], status: "off" });

  // Denied: setting on but host permission missing.
  await chrome.storage.local.set({ settings: { useSponsorBlock: true } });
  const originalContains = chrome.permissions.contains;
  chrome.permissions.contains = (_opts, cb) => cb(false);
  try {
    const denied = await fetchSponsorBlockSegmentsWithStatus(VIDEO_ID);
    assert.deepStrictEqual(denied, { segments: [], status: "denied" });
  } finally {
    chrome.permissions.contains = originalContains;
  }

  // Network: permission granted but the fetch throws.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    const network = await fetchSponsorBlockSegmentsWithStatus(VIDEO_ID);
    assert.deepStrictEqual(network, {
      segments: [],
      status: "network-error",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Empty: reachable API with no entry for this video.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [],
  });
  try {
    const empty = await fetchSponsorBlockSegmentsWithStatus(VIDEO_ID);
    assert.deepStrictEqual(empty, { segments: [], status: "empty" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
