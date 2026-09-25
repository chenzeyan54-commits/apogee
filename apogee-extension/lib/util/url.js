// Nullable URL constructor shared by best-effort host/protocol probes: user
// input and page-supplied hrefs are frequently unparseable, and every call
// site maps that to its own fallback (false, null, [], unset host).
export function tryParseUrl(url, base) {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}
