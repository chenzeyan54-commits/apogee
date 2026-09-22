import {
  clearIndexedKeys,
  estimateByteSize,
  evictKeysOverBudget,
  hashUrl,
  isQuotaError,
  shouldPersist,
} from "./pageCache.js";
import { createLock } from "../util/mutex.js";

function viewStateKey(tabId) {
  return `popupViewState:${tabId}`;
}

/**
 * Tab ids come from chrome.tabs and are non-negative integers. Anything else
 * (null, undefined, a URL string, floats) must never become a storage key:
 * `saveViewState(url, ...)` once created `popupViewState:https://...` keys
 * that leaked raw URLs into key names, were unreachable via
 * `loadViewState(tabId)`, and were never removed by `removeViewState(tabId)`
 * on tab close.
 */
export function isValidTabId(tabId) {
  return typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0;
}

/** Whether a view-state key is a legacy orphan keyed by something other than a numeric tab id. */
export function isOrphanedViewStateKey(key) {
  return (
    typeof key === "string" &&
    key.startsWith("popupViewState:") &&
    !/^\d+$/.test(key.slice("popupViewState:".length))
  );
}

const MAX_VIEW_STATES = 50;
// View states duplicate summary text per tab, so they get their own byte
// budget well inside the storage quota. Measured natively when possible,
// else the count cap alone applies.
export const MAX_VIEW_STATE_BYTES = 1_000_000;

const acquireViewStateLock = createLock();

async function preparePartial(partial) {
  let scrubContent = false;
  if (partial.url) {
    const url = partial.url;
    scrubContent = !(await shouldPersist(url));
    partial = {
      ...partial,
      url: undefined,
      urlHash: await hashUrl(url),
    };
  }
  return { partial, scrubContent };
}

async function writeViewState(tabId, partial, expectedJob = null) {
  if (!isValidTabId(tabId)) return null;
  const prepared = await preparePartial(partial);
  const release = await acquireViewStateLock();
  try {
    const key = viewStateKey(tabId);
    const { viewStateOrder = [], ...rest } = await chrome.storage.local.get([
      key,
      "viewStateOrder",
    ]);
    const current = rest[key] || {};
    if (
      expectedJob &&
      (current.jobId !== expectedJob.jobId ||
        (expectedJob.subview && current.subview !== expectedJob.subview))
    ) {
      return null;
    }
    const state = { ...current, ...prepared.partial };
    if (prepared.scrubContent) {
      delete state.question;
      delete state.answerText;
      delete state.summaryText;
    }

    const order = viewStateOrder.filter((k) => k !== key);
    order.push(key);
    // Byte-aware eviction without reading every state back.
    const removeKeys = await evictKeysOverBudget(order, {
      maxCount: MAX_VIEW_STATES,
      maxBytes: MAX_VIEW_STATE_BYTES,
      extraBytes: estimateByteSize(state),
    });

    try {
      await chrome.storage.local.set({ [key]: state, viewStateOrder: order });
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      // Ephemeral UI state, not the durable summary (finalize owns that and
      // already surfaces quota failures visibly): evict half the oldest
      // states and retry once, else drop this write with a warning.
      const extra = order.splice(0, Math.ceil(order.length / 2));
      removeKeys.push(...extra);
      try {
        await chrome.storage.local.set({ [key]: state, viewStateOrder: order });
      } catch (retryErr) {
        console.warn("View state dropped: browser storage is full.", retryErr);
        return null;
      }
    }
    if (removeKeys.length > 0) await chrome.storage.local.remove(removeKeys);
    return state;
  } finally {
    release();
  }
}

export function saveViewState(tabId, partial) {
  return writeViewState(tabId, partial);
}

export function saveViewStateIfJobMatches(
  tabId,
  jobId,
  partial,
  subview = null,
) {
  if (!jobId) return Promise.resolve(null);
  return writeViewState(tabId, partial, { jobId, subview });
}

export async function loadViewState(tabId) {
  if (!isValidTabId(tabId)) return null;
  const key = viewStateKey(tabId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

/** Whether a storage key holds popup view state rather than a setting. */
export function isViewStateKey(key) {
  return key.startsWith("popupViewState:") || key === "viewStateOrder";
}

/**
 * Delete every tab's saved view state, along with its order index. Reads
 * only the order index and the keys it names — never a full-store
 * `get(null)` scan — under the same lock as the writers, so a concurrent
 * write cannot resurrect entries into an index read before the wipe.
 */
export async function clearAllViewStates() {
  return clearIndexedKeys(acquireViewStateLock, ["viewStateOrder"]);
}

export async function removeViewState(tabId) {
  if (!isValidTabId(tabId)) return;
  const release = await acquireViewStateLock();
  try {
    const key = viewStateKey(tabId);
    const { viewStateOrder = [] } =
      await chrome.storage.local.get("viewStateOrder");
    const order = viewStateOrder.filter((k) => k !== key);
    await chrome.storage.local.set({ viewStateOrder: order });
    await chrome.storage.local.remove(key);
  } finally {
    release();
  }
}

/**
 * Remove legacy view-state entries keyed by something other than a numeric
 * tab id (e.g. `popupViewState:https://...` written by multi-tab
 * summarization before it used the owning tab's id), and drop their entries
 * from the order index. Runs under the same lock as the writers. Returns the
 * number of storage keys removed.
 *
 * This keeps one full-store read: orphans are by definition absent from the
 * order index, so only a scan finds them. It runs on tab close and on
 * install/startup — never on the write hot path.
 */
export async function cleanupOrphanedViewStates() {
  const release = await acquireViewStateLock();
  try {
    const all = await chrome.storage.local.get(null);
    const orphanKeys = Object.keys(all).filter(isOrphanedViewStateKey);
    if (orphanKeys.length === 0) {
      const order = all.viewStateOrder;
      if (!Array.isArray(order)) return 0;
      const pruned = order.filter((k) => !isOrphanedViewStateKey(k));
      if (pruned.length !== order.length) {
        await chrome.storage.local.set({ viewStateOrder: pruned });
        return order.length - pruned.length;
      }
      return 0;
    }
    const order = Array.isArray(all.viewStateOrder)
      ? all.viewStateOrder.filter((k) => !orphanKeys.includes(k))
      : [];
    await chrome.storage.local.set({ viewStateOrder: order });
    await chrome.storage.local.remove(orphanKeys);
    return orphanKeys.length;
  } finally {
    release();
  }
}
