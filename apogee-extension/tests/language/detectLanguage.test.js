import test from "node:test";
import assert from "node:assert";

import {
  LANG_DETECT_SAMPLE_CHARS,
  resolveEffectiveLanguage,
} from "../../lib/language/detectLanguage.js";

function stubDetect(language, percentage = 90) {
  globalThis.chrome = {
    i18n: {
      detectLanguage: async () => ({
        languages: language ? [{ language, percentage }] : [],
      }),
    },
  };
}

function clearDetect() {
  delete globalThis.chrome;
}

test("auto/unknown target never translates (and skips detection)", async () => {
  clearDetect();
  assert.strictEqual(
    await resolveEffectiveLanguage("hola mundo", "auto"),
    "auto",
  );
  assert.strictEqual(
    await resolveEffectiveLanguage("hola mundo", "xx"),
    "auto",
  );
});

test("English source + English target skips the identity translate pass", async () => {
  stubDetect("en");
  assert.strictEqual(
    await resolveEffectiveLanguage("This is an English article.", "en"),
    "auto",
  );
});

test("English source + Spanish target translates", async () => {
  stubDetect("en");
  assert.strictEqual(
    await resolveEffectiveLanguage("This is an English article.", "es"),
    "es",
  );
});

test("Spanish source + English target translates", async () => {
  stubDetect("es");
  assert.strictEqual(
    await resolveEffectiveLanguage("Esto es un artículo en español.", "en"),
    "en",
  );
});

test("region subtags compare by base code (en-US matches en)", async () => {
  stubDetect("en-US");
  assert.strictEqual(await resolveEffectiveLanguage("text", "en"), "auto");
});

test("unsure/unavailable detection errs toward translating for correctness", async () => {
  stubDetect("en", 20);
  assert.strictEqual(await resolveEffectiveLanguage("text", "es"), "es");
  clearDetect();
  assert.strictEqual(await resolveEffectiveLanguage("text", "es"), "es");
});

test("detection samples at most LANG_DETECT_SAMPLE_CHARS characters", async () => {
  let seen = null;
  globalThis.chrome = {
    i18n: {
      detectLanguage: async (sample) => {
        seen = sample;
        return { languages: [{ language: "en", percentage: 90 }] };
      },
    },
  };
  await resolveEffectiveLanguage(
    `${"x".repeat(LANG_DETECT_SAMPLE_CHARS + 500)}`,
    "es",
  );
  assert.strictEqual(seen.length, LANG_DETECT_SAMPLE_CHARS);
});

test.after(() => clearDetect());
