// Shared video-extractor primitives for the YouTube and Bilibili content
// scripts (same classic-script scope as thread.js, loaded before both).
// Kept free of DOM/text helpers on purpose: youtube.js loads before
// thread.js in the injection order, so this module depends on nothing.

// Brace-matched JSON slice for the embedded player-state script blobs
// (ytInitialPlayerResponse, __INITIAL_STATE__): string-aware so braces
// inside quoted values never end the slice early.
function extractBalancedJsonText(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return null;
}

// Nullable URL constructor for fallible page-supplied hrefs. The lib side
// has the same helper (lib/util/url.js), but content scripts run in
// classic-script scope and cannot import the ES module, so this mirror lives
// here next to findEmbeddedJson.
function tryParseUrl(url, base) {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

// Shared embedded-state scan for youtube.js (ytInitialPlayerResponse) and
// bilibili.js (__INITIAL_STATE__): same candidate loop over script blobs,
// only the marker, the assignment pattern, and the per-candidate validation
// differ. Returns the first parsed candidate accepted by validate, or null
// when nothing parses or matches.
function findEmbeddedJson(scripts, marker, assignPattern, validate) {
  for (const script of scripts) {
    const text = script?.textContent || "";
    if (!text || !text.includes(marker)) continue;
    const assign = text.match(assignPattern);
    if (!assign) continue;
    const openIndex = text.indexOf("{", assign.index + assign[0].length);
    if (openIndex === -1) continue;
    const json = extractBalancedJsonText(text, openIndex);
    if (!json) continue;
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      // intent: fall through to next candidate if JSON parse fails
      continue;
    }
    if (validate && !validate(parsed)) continue;
    return parsed;
  }
  return null;
}

function formatVideoTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Timestamp-marked transcript assembly: a [m:ss] marker roughly every
// interval seconds, then the segment texts collapsed to single spaces.
function markTranscriptSegments(segments, formatFn, interval) {
  let lastMarked = -Infinity;
  const parts = [];
  for (const seg of segments) {
    if (seg.start - lastMarked >= interval) {
      parts.push(`[${formatFn(seg.start)}]`);
      lastMarked = seg.start;
    }
    parts.push(seg.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Long descriptions are secondary context once a transcript exists: keep the
// head so the prompt stays bounded.
function truncateVideoDescription(cleanedDescription, transcript) {
  if (transcript && cleanedDescription.length > 500) {
    return `${cleanedDescription.slice(0, 500).trim()}…`;
  }
  return cleanedDescription;
}
