import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

function makeElement(tag, options = {}) {
  return {
    tagName: String(tag).toUpperCase(),
    hidden: options.hidden ?? false,
    style: {
      display: options.inlineDisplay ?? "",
      visibility: options.inlineVisibility ?? "",
    },
    parentElement: options.parent ?? null,
    _computed: {
      display: options.computedDisplay ?? "block",
      visibility: options.computedVisibility ?? "visible",
    },
  };
}

function makeText(value, parent) {
  return { nodeValue: value, parentElement: parent };
}

function installFakeDom(textNodes) {
  const styleCalls = new Map();
  const fakeWindow = {
    getComputedStyle(el) {
      styleCalls.set(el, (styleCalls.get(el) ?? 0) + 1);
      return {
        display: el._computed.display,
        visibility: el._computed.visibility,
      };
    },
    matchMedia: () => ({ matches: false }),
  };
  const fakeNodeFilter = {
    SHOW_TEXT,
    FILTER_ACCEPT,
    FILTER_REJECT,
    FILTER_SKIP: 3,
  };
  const fakeDocument = {
    createTreeWalker(root, _type, filter) {
      const accepted = [];
      for (const tn of textNodes) {
        let cur = tn.parentElement;
        let under = false;
        while (cur) {
          if (cur === root) {
            under = true;
            break;
          }
          cur = cur.parentElement;
        }
        if (!under) continue;
        if (filter.acceptNode(tn) === FILTER_ACCEPT) accepted.push(tn);
      }
      let index = 0;
      return {
        nextNode() {
          return index < accepted.length ? accepted[index++] : null;
        },
      };
    },
  };
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  globalThis.NodeFilter = fakeNodeFilter;
  if (typeof globalThis.MutationObserver !== "undefined") {
    delete globalThis.MutationObserver;
  }
  return { styleCalls };
}

const highlightUrl = new URL("../../content/highlight.js", import.meta.url);
const { buildTextIndex, getTextIndex, _resetHighlightCacheForTesting } =
  await import(highlightUrl);

test("hidden nodes are excluded while visible passages stay unchanged", () => {
  const body = makeElement("body");
  const visibleP = makeElement("p", { parent: body });
  const hiddenDiv = makeElement("div", {
    parent: body,
    computedDisplay: "none",
  });
  const hiddenP = makeElement("p", { parent: hiddenDiv });
  const invisSpan = makeElement("span", {
    parent: visibleP,
    computedVisibility: "hidden",
  });
  const scriptEl = makeElement("script", { parent: body });
  const styleEl = makeElement("style", { parent: body });
  const noscriptEl = makeElement("noscript", { parent: body });

  const textNodes = [
    makeText("Hello world visible. ", visibleP),
    makeText("secret hidden text", hiddenP),
    makeText("ancestor hidden text", hiddenDiv),
    makeText("invisible text", invisSpan),
    makeText("var x = 1;", scriptEl),
    makeText(".a { color: red; }", styleEl),
    makeText("noscript fallback", noscriptEl),
    makeText("More visible text.", visibleP),
  ];
  installFakeDom(textNodes);
  _resetHighlightCacheForTesting();

  const { text } = buildTextIndex(body);
  assert.ok(
    text.includes("Hello world visible."),
    "visible text must stay in the index",
  );
  assert.ok(
    text.includes("More visible text."),
    "second visible node must stay in the index",
  );
  for (const hidden of [
    "secret hidden text",
    "ancestor hidden text",
    "invisible text",
    "var x = 1;",
    "noscript fallback",
  ]) {
    assert.ok(
      !text.includes(hidden),
      `hidden text must be excluded: ${hidden}`,
    );
  }
});

test("getComputedStyle runs at most once per unique parent element", () => {
  const body = makeElement("body");
  const para = makeElement("p", { parent: body });
  const textNodes = [];
  for (let i = 0; i < 50; i += 1) {
    textNodes.push(makeText(`word${i} `, para));
  }
  const { styleCalls } = installFakeDom(textNodes);
  _resetHighlightCacheForTesting();

  const { text } = buildTextIndex(body);
  assert.ok(text.includes("word0"), "indexed text must include first node");
  assert.ok(text.includes("word49"), "indexed text must include last node");
  const paraCalls = styleCalls.get(para) ?? 0;
  assert.ok(
    paraCalls <= 1,
    `shared parent must be probed at most once (got ${paraCalls})`,
  );
  assert.ok(
    styleCalls.size <= 2,
    `only unique elements are probed (got ${styleCalls.size})`,
  );
});

test("the index is built once and reused for the same root", () => {
  const body = makeElement("body");
  const para = makeElement("p", { parent: body });
  const textNodes = [makeText("Reusable visible passage.", para)];
  installFakeDom(textNodes);
  _resetHighlightCacheForTesting();

  const first = getTextIndex(body);
  const second = getTextIndex(body);
  assert.strictEqual(
    second,
    first,
    "same root must return the cached index without rebuilding",
  );
  assert.ok(
    first.text.includes("Reusable visible passage."),
    "cached index must hold the visible passage",
  );

  _resetHighlightCacheForTesting();
  const rebuilt = getTextIndex(body);
  assert.notStrictEqual(rebuilt, first, "reset must allow a rebuild");
  assert.strictEqual(
    rebuilt.text,
    first.text,
    "rebuilt index text must be unchanged",
  );
});

test("highlight source caches visibility and reuses the index", () => {
  const highlightSrc = readFileSync(highlightUrl, "utf8");
  assert.match(
    highlightSrc,
    /visibilityCache/,
    "buildTextIndex must cache visibility per parent element",
  );
  assert.match(
    highlightSrc,
    /getCachedStyle|styleCache/,
    "computed styles must go through a per-element cache",
  );
  assert.match(
    highlightSrc,
    /function getTextIndex|getTextIndex\(document\.body\)/,
    "the content script must build the index once and reuse it",
  );
});
