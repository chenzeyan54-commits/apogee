import test from "node:test";
import assert from "node:assert";

import { chatStream, checkHealth } from "../../lib/engines/ollamaClient.js";
import { UserFacingError } from "../../lib/util/userError.js";
import { collectAsync } from "../helpers/streamTestUtils.js";

function createMockStreamResponse(chunks, options = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    headers: options.headers ?? { "Content-Type": "application/x-ndjson" },
  });
}

test("checkHealth: returns connected true and model list on 200 response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    assert.strictEqual(url, "http://127.0.0.1:11434/api/tags");
    return new Response(
      JSON.stringify({
        models: [{ model: "llama3.2:latest" }, { name: "qwen2.5:latest" }],
      }),
      { status: 200 },
    );
  };

  const result = await checkHealth("http://127.0.0.1:11434");
  assert.deepStrictEqual(result, {
    connected: true,
    models: ["llama3.2:latest", "qwen2.5:latest"],
  });
});

test("checkHealth: returns connected false when response is not OK", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response("Not Found", { status: 404 });

  const result = await checkHealth("http://127.0.0.1:11434");
  assert.deepStrictEqual(result, { connected: false, models: [] });
});

test("checkHealth: returns connected false when fetch throws network error", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };

  const result = await checkHealth("http://127.0.0.1:11434");
  assert.deepStrictEqual(result, { connected: false, models: [] });
});

test("chatStream: streams content chunks successfully", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let capturedBody;
  globalThis.fetch = async (url, opts) => {
    assert.strictEqual(url, "http://127.0.0.1:11434/api/chat");
    capturedBody = JSON.parse(opts.body);
    const ndjson = [
      JSON.stringify({ message: { content: "Hello " } }) + "\n",
      JSON.stringify({ message: { content: "world!" } }) + "\n",
    ];
    return createMockStreamResponse(ndjson);
  };

  const chunks = await collectAsync(
    chatStream("http://127.0.0.1:11434", "llama3.2", "Hi", {
      system: "Be concise",
    }),
  );

  assert.deepStrictEqual(chunks, ["Hello ", "world!"]);
  assert.strictEqual(capturedBody.model, "llama3.2");
  assert.strictEqual(capturedBody.stream, true);
  assert.deepStrictEqual(capturedBody.messages, [
    { role: "system", content: "Be concise" },
    { role: "user", content: "Hi" },
  ]);
});

test("chatStream: reports eval_count/eval_duration via onFinalStats", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    const ndjson = [
      JSON.stringify({ message: { content: "Hi" } }) + "\n",
      JSON.stringify({
        message: { content: "" },
        done: true,
        eval_count: 42,
        eval_duration: 2_000_000_000,
      }) + "\n",
    ];
    return createMockStreamResponse(ndjson);
  };

  let stats = null;
  await collectAsync(
    chatStream("http://127.0.0.1:11434", "llama3.2", "Hi", {
      onFinalStats: (s) => {
        stats = s;
      },
    }),
  );

  assert.deepStrictEqual(stats, { tokens: 42, durationMs: 2000 });
});

test("chatStream: handles non-OK HTTP status with JSON error payload", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "model 'unknown' not found" }), {
      status: 404,
    });

  await assert.rejects(
    async () => {
      await collectAsync(
        chatStream("http://127.0.0.1:11434", "unknown", "Hi"),
      );
    },
    (err) => {
      assert.ok(err instanceof UserFacingError);
      assert.match(
        err.message,
        /Ollama returned an error for model 'unknown': model 'unknown' not found/,
      );
      return true;
    },
  );
});

test("chatStream: handles non-OK HTTP status with non-JSON response body", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response("Internal Server Error", { status: 500 });

  await assert.rejects(
    async () => {
      await collectAsync(
        chatStream("http://127.0.0.1:11434", "llama3.2", "Hi"),
      );
    },
    (err) => {
      assert.ok(err instanceof UserFacingError);
      assert.match(
        err.message,
        /Ollama returned an error for model 'llama3.2': Internal Server Error/,
      );
      return true;
    },
  );
});

test("chatStream: throws OllamaError when stream emits in-stream error object", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    const ndjson = [
      JSON.stringify({ message: { content: "Starting..." } }) + "\n",
      JSON.stringify({ error: "CUDA out of memory" }) + "\n",
    ];
    return createMockStreamResponse(ndjson);
  };

  await assert.rejects(
    async () => {
      await collectAsync(
        chatStream("http://127.0.0.1:11434", "llama3.2", "Hi"),
      );
    },
    (err) => {
      assert.ok(err instanceof UserFacingError);
      assert.match(
        err.message,
        /Ollama returned an error for model 'llama3.2': CUDA out of memory/,
      );
      return true;
    },
  );
});

test("chatStream: throws OllamaError when stream emits malformed JSON line", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    const invalidNdjson = ["{ invalid json line }\n"];
    return createMockStreamResponse(invalidNdjson);
  };

  await assert.rejects(
    async () => {
      await collectAsync(
        chatStream("http://127.0.0.1:11434", "llama3.2", "Hi"),
      );
    },
    (err) => {
      assert.ok(err instanceof UserFacingError);
      assert.match(
        err.message,
        /Ollama sent a malformed response for model 'llama3.2'/,
      );
      return true;
    },
  );
});

test("chatStream: throws cancellation error when AbortSignal is triggered", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const controller = new AbortController();
  globalThis.fetch = async () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  };

  await assert.rejects(
    async () => {
      await collectAsync(
        chatStream("http://127.0.0.1:11434", "llama3.2", "Hi", {
          signal: controller.signal,
        }),
      );
    },
    (err) => {
      assert.ok(err instanceof UserFacingError);
      assert.strictEqual(err.message, "Generation was cancelled.");
      return true;
    },
  );
});

test("chatStream: handles connection refusal / network error", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    async () => {
      await collectAsync(
        chatStream("http://127.0.0.1:11434", "llama3.2", "Hi"),
      );
    },
    (err) => {
      assert.ok(err instanceof UserFacingError);
      assert.match(
        err.message,
        /Could not connect to Ollama at http:\/\/127\.0\.0\.1:11434/,
      );
      return true;
    },
  );
});
