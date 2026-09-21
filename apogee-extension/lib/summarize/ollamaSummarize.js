import { chunkBySections } from "./sections.js";
import {
  buildSummaryPrompt,
  buildDiscussionPrompt,
  buildExtractNotesPrompt,
  buildSynthesisPrompt,
  buildScaledBulletsStyle,
  withCustomInstructions,
} from "./prompts.js";
import { isVideoType } from "../constants.js";
import { detectPrimaryLanguage } from "../language/detectLanguage.js";
import { chatStream } from "../engines/ollamaClient.js";
import { mapReduceStream } from "./mapReduce.js";
import { summarizeYoutube } from "./youtubeSummarize.js";

const POST_CONTEXT_EXCERPT_CHARS = 800;

export function discussionPostExcerpt(content) {
  const m = content.match(
    /\nPost:\n([\s\S]*?)\n\n(?:Comments \(|\(No comments)/,
  );
  if (!m) return "";
  const body = m[1].trim();
  return body.length > POST_CONTEXT_EXCERPT_CHARS
    ? `${body.slice(0, POST_CONTEXT_EXCERPT_CHARS).trim()}…`
    : body;
}

export async function* summarizeText(
  {
    text,
    title,
    url,
    mode,
    model,
    host,
    signal,
    type,
    language,
    customInstructions,
    isSelection = false,
    focusKeyword = "",
  },
  {
    chunkTextFn = chunkBySections,
    chatStreamFn = chatStream,
    onProgress,
    detectLanguageFn = detectPrimaryLanguage,
    translateFn,
    selectChunksFn,
  } = {},
) {
  if (isVideoType(type)) {
    yield* summarizeYoutube(
      {
        text,
        title,
        url,
        mode,
        model,
        host,
        signal,
        language,
        customInstructions,
      },
      { chunkTextFn, chatStreamFn, onProgress, detectLanguageFn, translateFn },
    );
    return;
  }

  const isDiscussion =
    type === "hackernews" || type === "reddit" || type === "stackoverflow";
  const buildPrompt = isDiscussion ? buildDiscussionPrompt : buildSummaryPrompt;

  const postExcerpt = isDiscussion ? discussionPostExcerpt(text) : "";
  const withPostContext = (chunk, i) =>
    i > 0 && postExcerpt
      ? `[Post context]\n${postExcerpt}\n\n[Comments in this part of the thread]\n${chunk}`
      : chunk;

  const scaledFor = (partials) =>
    mode === "bullets" ? buildScaledBulletsStyle(partials.length) : undefined;

  yield* mapReduceStream(
    { text, model, host, signal, language },
    {
      chunkTextFn,
      chatStreamFn,
      onProgress,
      detectLanguageFn,
      translateFn,
      selectChunksFn,
    },
    {
      buildSingle: (chunk) =>
        withCustomInstructions(
          buildPrompt(
            title,
            url,
            chunk,
            mode,
            undefined,
            isSelection,
            focusKeyword,
          ),
          customInstructions,
        ),
      buildMap: isDiscussion
        ? (chunk, i) => buildPrompt(title, url, withPostContext(chunk, i), mode)
        : (chunk, i, total) =>
            buildExtractNotesPrompt(title, chunk, i, total, focusKeyword),
      buildReduce: isDiscussion
        ? (partials) =>
            withCustomInstructions(
              buildPrompt(
                title,
                url,
                partials.join("\n"),
                mode,
                scaledFor(partials),
                isSelection,
              ),
              customInstructions,
            )
        : (partials) =>
            withCustomInstructions(
              buildSynthesisPrompt(
                title,
                url,
                partials.join("\n"),
                mode,
                scaledFor(partials),
                focusKeyword,
              ),
              customInstructions,
            ),
    },
  );
}
