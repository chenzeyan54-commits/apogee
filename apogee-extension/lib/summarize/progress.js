// Shared summarize-progress narration for the offscreen document and the
// service worker.
//
// Both runtimes report long map-reduce jobs the same way: a sticky "Long
// page" prefix once truncation kicks in, a stage label otherwise, and a
// word-count ticker every WORD_REPORT_EVERY tokens. The only difference is
// the sink, so callers pass a `report(text)` callback and get back an
// `onProgress` handler for summarizeText stage events plus a per-token
// `trackWord` ticker.

export const WORD_REPORT_EVERY = 24;

export function createSummarizeProgressTracker(report) {
  let longNote = "";
  let stageLabel = "Summarizing...";

  const onProgress = (p) => {
    if (p.stage === "truncated") {
      longNote = "Long page - summarizing the key parts. ";
      report(longNote.trim());
      return;
    }
    if (p.stage === "reduce") stageLabel = "Merging summary...";
    else if (p.stage === "translate") stageLabel = "Translating...";
    else stageLabel = `Summarizing part ${p.index + 1} of ${p.total}...`;
    report(longNote + stageLabel);
  };

  // Call with a running 1-based token count; reports every WORD_REPORT_EVERY.
  const trackWord = (count) => {
    if (count % WORD_REPORT_EVERY === 0) {
      report(`${longNote}${stageLabel} (${count} words)`);
    }
  };

  return { onProgress, trackWord };
}
