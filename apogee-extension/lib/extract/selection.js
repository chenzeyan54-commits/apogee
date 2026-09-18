export const MIN_SELECTION_LENGTH = 20;
export const SELECTION_CAPTURE_TIMEOUT_MS = 60000;

export function normalizeSelectedText(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

export function isSummarizableSelection(text) {
  return normalizeSelectedText(text).length >= MIN_SELECTION_LENGTH;
}

export async function activateSelectionCapture(
  tab,
  timeoutMs = SELECTION_CAPTURE_TIMEOUT_MS,
) {
  if (!tab?.id || typeof chrome === "undefined") return false;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (minLength, timeout) => {
      if (window.__apogeeSelectionCapture) {
        if (typeof window.__apogeeSelectionCaptureTeardown === "function") {
          window.__apogeeSelectionCaptureTeardown();
        }
      }
      window.__apogeeSelectionCapture = true;
      let sent = false;
      let timer = null;

      const teardown = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (typeof document !== "undefined") {
          document.removeEventListener("selectionchange", capture, true);
        }
        if (typeof window !== "undefined") {
          window.removeEventListener("mouseup", capture, true);
          delete window.__apogeeSelectionCapture;
          delete window.__apogeeSelectionCaptureTeardown;
        }
      };

      window.__apogeeSelectionCaptureTeardown = teardown;

      const capture = () => {
        if (sent) return;
        const text = window
          .getSelection()
          ?.toString()
          .replace(/\s+/g, " ")
          .trim();
        if (!text || text.length < minLength) return;
        sent = true;
        chrome.runtime.sendMessage({
          target: "service-worker",
          action: "summarize-selection",
          payload: { selectionText: text },
        });
        teardown();
      };

      document.addEventListener("selectionchange", capture, true);
      window.addEventListener("mouseup", capture, true);

      if (timeout > 0) {
        timer = setTimeout(teardown, timeout);
      }
    },
    args: [MIN_SELECTION_LENGTH, timeoutMs],
  });
  return true;
}
