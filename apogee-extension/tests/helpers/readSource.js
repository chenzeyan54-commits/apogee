import fs from "node:fs";

// Shared source-reading helper for wiring-guard tests (in the style of
// offscreenKeepAlive.test.js): tests assert on the shipped source to lock
// cross-runtime call sites together.
export function readSource(relPath, baseUrl) {
  return fs.readFileSync(new URL(relPath, baseUrl), "utf-8");
}
