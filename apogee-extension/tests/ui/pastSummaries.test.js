import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { searchPastSummaries } from "../../lib/retrieval/pastSummariesSearch.js";

// app.js owns DOM globals at import time, so these tests assert on its
// source (same precedent as finalizeFailure.test.js) plus the search
// behavior the popup now relies on.

const appSource = fs.readFileSync(
  new URL("../../ui/app.js", import.meta.url),
  "utf-8",
);

function filterPastSummariesSource() {
  const start = appSource.indexOf("async function filterPastSummaries");
  assert.ok(start !== -1, "filterPastSummaries exists");
  const end = appSource.indexOf("if (pastSummariesFilter)", start);
  assert.ok(end !== -1, "filterPastSummaries has a clear end");
  return appSource.slice(start, end);
}

test("popup search runs over the full index, not the last-8 slice (#313)", () => {
  const body = filterPastSummariesSource();
  assert.ok(
    !body.includes("PAST_SUMMARIES_SHOWN"),
    "filter must not window to 8",
  );
  assert.ok(
    body.includes("storedSummaries: stored"),
    "filter searches fetched texts",
  );
});

test("popup delete goes through the atomic storage helper (#313)", () => {
  assert.ok(appSource.includes("await removeCachedSummary(entry.s)"));
});

test("search finds summaries older than the last 8 (#313)", async () => {
  const cacheOrder = Array.from({ length: 12 }, (_, i) => ({
    s: `k${i}`,
    p: `p${i}`,
    t: `Article ${i}`,
  }));
  const storedSummaries = Object.fromEntries(
    cacheOrder.map((e) => [e.s, `Body text for ${e.s}`]),
  );
  storedSummaries.k0 = "Body text with a UNIQUEWORD cavern-wall ancients";

  const results = await searchPastSummaries({
    query: "UNIQUEWORD",
    cacheOrder,
    storedSummaries,
    embedTextsFn: null,
  });

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].s, "k0");
});
