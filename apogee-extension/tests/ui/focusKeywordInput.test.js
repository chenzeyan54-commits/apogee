import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import { parseHTML } from "linkedom";

// #161: a per-page focus keyword input. app.js relies on chrome.* tab events
// and DOM state that this repo doesn't execute in tests (see
// popupMessageGate.test.js / validateLoopbackHost.test.js) - so, like those,
// the behavioral assertions here are source-text inspections rather than a
// live DOM run.

const appHtmlPath = new URL("../../ui/app.html", import.meta.url);
const appHtmlRaw = readFileSync(appHtmlPath, "utf8");

const appCode = fs.readFileSync(
  new URL("../../ui/app.js", import.meta.url),
  "utf-8",
);

test("app.html declares the focus keyword input with the documented cap (#161)", () => {
  const { document } = parseHTML(appHtmlRaw);
  const input = document.getElementById("focusKeywordInput");
  assert.ok(input, "#focusKeywordInput must exist in app.html");
  assert.strictEqual(input.getAttribute("type"), "text");
  assert.strictEqual(input.getAttribute("maxlength"), "200");
});

test("the focus keyword input is cleared on tab switch (#161)", () => {
  const onActivatedMatch = appCode.match(
    /chrome\.tabs\.onActivated\.addListener\(\(\) => \{[\s\S]*?\n {4}\}\);/,
  );
  assert.ok(onActivatedMatch, "chrome.tabs.onActivated listener found");
  assert.match(onActivatedMatch[0], /focusKeywordInput\.value = ""/);
});

test("the focus keyword input is cleared on same-tab navigation to a new URL (#161)", () => {
  const onUpdatedMatch = appCode.match(
    /chrome\.tabs\.onUpdated\.addListener\(\(tabId, changeInfo\) => \{[\s\S]*?\n\}\);/,
  );
  assert.ok(onUpdatedMatch, "chrome.tabs.onUpdated listener found");
  const body = onUpdatedMatch[0];
  assert.match(body, /changeInfo\.url/);
  assert.match(body, /tabId !== activeTabId/);
  assert.match(body, /focusKeywordInput\.value = ""/);
});

test("re-summarizing the same page does not clear the focus keyword (#161)", () => {
  const line = appCode
    .split("\n")
    .find((l) => l.includes('resummarizeBtn?.addEventListener("click"'));
  assert.ok(line, "resummarizeBtn click handler found");
  assert.doesNotMatch(line, /focusKeywordInput\.value/);
});

test("the focus keyword input is hidden on discussion, video, and multi-tab pages (#161)", () => {
  const fnMatch = appCode.match(
    /function updateFocusKeywordAvailability[\s\S]*?\n\}/,
  );
  assert.ok(fnMatch, "updateFocusKeywordAvailability function found");
  const body = fnMatch[0];
  for (const needle of [
    "isVideoType(type)",
    '"hackernews"',
    '"reddit"',
    '"stackoverflow"',
    '"multi-tab"',
  ]) {
    assert.ok(body.includes(needle), `expected ${needle} in the hide check`);
  }

  // Must actually be wired into the shared page-type resolver so every
  // existing (and future) call site stays in sync automatically.
  const chipFnMatch = appCode.match(/function updateExtractorChip[\s\S]*?\n\}/);
  assert.ok(chipFnMatch, "updateExtractorChip function found");
  assert.match(chipFnMatch[0], /updateFocusKeywordAvailability\(pageData\)/);
});
