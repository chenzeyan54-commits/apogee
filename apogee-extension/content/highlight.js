// The passage matcher lives in lib/retrieval/passageMatch.js and is bundled
// into this content script by Vite (see vite.config.js), so there is a single
// source of truth instead of a duplicated block.
import { findMatchingRange } from "../lib/retrieval/passageMatch.js";

const HIDDEN_TAG_NAMES = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);

// Reused across highlight calls on the same page so long articles pay the
// TreeWalker + style-probe cost once instead of on every highlight request.
let cachedIndexRoot = null;
let cachedIndex = null;
let cachedIndexDirty = false;
let cachedIndexObserver = null;

function observeRootForMutations(root) {
  if (cachedIndexObserver) {
    cachedIndexObserver.disconnect();
    cachedIndexObserver = null;
  }
  const doc = root?.ownerDocument;
  const MutationObserverCtor =
    (typeof MutationObserver !== "undefined" && MutationObserver) ||
    (doc?.defaultView?.MutationObserver ?? null);
  if (!MutationObserverCtor || !root) return;
  try {
    cachedIndexObserver = new MutationObserverCtor(() => {
      cachedIndexDirty = true;
    });
    cachedIndexObserver.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  } catch {
    cachedIndexObserver = null;
  }
}

function getCachedStyle(element, styleCache) {
  let entry = styleCache.get(element);
  if (entry) return entry;
  const computed = window.getComputedStyle(element);
  entry = {
    display: computed.display,
    visibility: computed.visibility,
  };
  styleCache.set(element, entry);
  return entry;
}

// One style probe per unique element at most: results are cached per parent,
// and ancestor display:none checks reuse the same cache instead of forcing a
// recalculation for every text node.
function isHiddenParent(parent, visibilityCache, styleCache) {
  const seen = visibilityCache.get(parent);
  if (seen !== undefined) return seen;

  const tag = parent.tagName;
  if (HIDDEN_TAG_NAMES.has(tag)) {
    visibilityCache.set(parent, true);
    return true;
  }
  if (parent.hidden) {
    visibilityCache.set(parent, true);
    return true;
  }
  // Inline style is free (no forced recalc); computed style is cached.
  if (
    parent.style?.display === "none" ||
    parent.style?.visibility === "hidden"
  ) {
    visibilityCache.set(parent, true);
    return true;
  }

  const own = getCachedStyle(parent, styleCache);
  // visibility is inherited in the computed style, so the parent's own value
  // already reflects an inherited visibility:hidden (unless overridden, in
  // which case the parent really is visible).
  if (own.visibility === "hidden" || own.display === "none") {
    visibilityCache.set(parent, true);
    return true;
  }

  // display is not inherited: an ancestor with display:none still hides this
  // subtree even though the parent computes to display:block. Walk ancestors
  // once, caching each probe so shared ancestors pay only once per index.
  let ancestor = parent.parentElement;
  while (ancestor) {
    const ancestorHidden = visibilityCache.get(ancestor);
    if (ancestorHidden !== undefined) {
      if (ancestorHidden) {
        visibilityCache.set(parent, true);
        return true;
      }
      ancestor = ancestor.parentElement;
      continue;
    }
    if (HIDDEN_TAG_NAMES.has(ancestor.tagName) || ancestor.hidden) {
      visibilityCache.set(ancestor, true);
      visibilityCache.set(parent, true);
      return true;
    }
    if (ancestor.style?.display === "none") {
      visibilityCache.set(ancestor, true);
      visibilityCache.set(parent, true);
      return true;
    }
    const ancestorStyle = getCachedStyle(ancestor, styleCache);
    if (ancestorStyle.display === "none") {
      visibilityCache.set(parent, true);
      return true;
    }
    ancestor = ancestor.parentElement;
  }

  visibilityCache.set(parent, false);
  return false;
}

export function buildTextIndex(root) {
  // Per-build caches: visibilityCache (Element -> boolean) answers "hidden?"
  // while styleCache (Element -> {display, visibility}) holds the single
  // getComputedStyle probe per unique element. Text nodes sharing a parent
  // hit the cache instead of forcing another recalculation.
  const visibilityCache = new Map();
  const styleCache = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (isHiddenParent(parent, visibilityCache, styleCache)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let text = "";
  const records = [];
  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue || "";
    if (!value) continue;
    records.push({
      node,
      start: text.length,
      end: text.length + value.length,
    });
    text += value;
  }
  return { text, records };
}

export function getTextIndex(root) {
  if (cachedIndex && cachedIndexRoot === root && !cachedIndexDirty) {
    return cachedIndex;
  }
  cachedIndex = buildTextIndex(root);
  cachedIndexRoot = root;
  cachedIndexDirty = false;
  observeRootForMutations(root);
  return cachedIndex;
}

export function _resetHighlightCacheForTesting() {
  if (cachedIndexObserver) {
    cachedIndexObserver.disconnect();
    cachedIndexObserver = null;
  }
  cachedIndex = null;
  cachedIndexRoot = null;
  cachedIndexDirty = false;
}

function rangeFromOffsets(records, start, end) {
  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;

  for (const record of records) {
    if (startNode === null && start >= record.start && start < record.end) {
      startNode = record.node;
      startOffset = start - record.start;
    }
    if (end > record.start && end <= record.end) {
      endNode = record.node;
      endOffset = end - record.start;
      break;
    }
  }
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

const APOGEE_HIGHLIGHT_NAME = "apogee-grounding";

function performHighlight(chunkText) {
  try {
    const { text, records } = getTextIndex(document.body);
    const match = findMatchingRange(text, chunkText);
    if (!match) return { found: false, highlighted: false };

    const range = rangeFromOffsets(records, match.start, match.end);
    if (!range) return { found: false, highlighted: false };

    const scrollTarget = range.startContainer.parentElement || document.body;

    let highlighted = false;
    if (typeof CSS !== "undefined" && CSS.highlights) {
      CSS.highlights.delete(APOGEE_HIGHLIGHT_NAME);
      CSS.highlights.set(APOGEE_HIGHLIGHT_NAME, new Highlight(range));
      highlighted = true;
    }

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    scrollTarget.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "center",
    });
    return { found: true, highlighted };
  } catch (err) {
    console.error("Apogee highlight failed:", err);
    return { found: false, highlighted: false };
  }
}

if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  chrome.runtime.onMessage
) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id) return;
    // Highlight requests come from the extension page via tabs.sendMessage
    // (no sender tab); tab-hosted contexts must not trigger page highlights.
    if (sender.tab) return;
    if (message && message.action === "apogee-highlight") {
      const result = performHighlight(message.chunkText);
      sendResponse(result);
      return true;
    }
  });
}

true;
