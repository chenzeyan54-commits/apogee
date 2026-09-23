// Sliding-expiry timers for buffered streams (issue #314).
//
// A fixed 2-min cleanup deletes long map-reduce jobs mid-generation even
// though tokens are still arriving. These timers slide instead: every chunk
// of progress reschedules expiry a full window out, so an actively
// progressing stream never expires while idle streams are still reclaimed.
//
// Framework-free (setTimeout only) so both the offscreen document and unit
// tests can use it; the service worker mirrors the same pattern with
// chrome.alarms (re-creating an alarm overwrites it).

export const STREAM_CLEANUP_MS = 2 * 60 * 1000;

export function createSlidingExpiry({
  timeoutMs = STREAM_CLEANUP_MS,
  onExpire,
} = {}) {
  const timers = new Map();

  function cancel(id) {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
  }

  function schedule(id) {
    cancel(id);
    const handle = setTimeout(() => {
      timers.delete(id);
      onExpire?.(id);
    }, timeoutMs);
    // Node test runners hold the event loop for active timeouts; browsers
    // return a number here so this is a no-op in the extension.
    if (typeof handle?.unref === "function") {
      try {
        handle.unref();
      } catch {}
    }
    timers.set(id, handle);
  }

  return { schedule, cancel };
}
