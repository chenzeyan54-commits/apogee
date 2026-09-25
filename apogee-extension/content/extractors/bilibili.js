function getBiliInitialState() {
  const path = location.pathname.toLowerCase();
  return findEmbeddedJson(
    liveEls(document.querySelectorAll("script")),
    "__INITIAL_STATE__",
    /window\.__INITIAL_STATE__\s*=\s*/,
    (parsed) => {
      const bvid = parsed?.bvid || parsed?.videoData?.bvid;
      const aid = parsed?.aid || parsed?.videoData?.aid;
      if (bvid && !path.includes(String(bvid).toLowerCase())) {
        return !!aid && path.includes(String(aid).toLowerCase());
      }
      return true;
    },
  );
}

const BILI_TIMESTAMP_MARKER_INTERVAL_SECONDS = 20;

function buildBiliTranscript(segments) {
  if (!segments.length) return "";
  return markTranscriptSegments(
    segments,
    formatVideoTimestamp,
    BILI_TIMESTAMP_MARKER_INTERVAL_SECONDS,
  );
}

function cleanBiliDescription(description) {
  if (!description) return "";
  const urlOnlyLine = /^\s*(https?:\/\/|www\.)\S+\s*$/i;
  return description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !urlOnlyLine.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchBiliSubtitles({ aid, bvid, cid }) {
  try {
    const resp = await chrome.runtime.sendMessage({
      target: "service-worker",
      action: "bilibili-subtitles",
      payload: {
        aid,
        bvid,
        cid,
        preferredLang: navigator.language || "zh",
      },
    });
    return {
      segments: Array.isArray(resp?.segments) ? resp.segments : [],
      status: typeof resp?.status === "string" ? resp.status : "empty",
    };
  } catch {
    return { segments: [], status: "network-error" };
  }
}

async function extractBilibili() {
  const state = getBiliInitialState();
  const videoData = state?.videoData;
  if (!videoData || !videoData.title) return null;

  const title = videoData.title;
  const channel = videoData.owner?.name || "";
  const description = videoData.desc || videoData.dynamic || "";

  const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
  const partParam = Number(new URLSearchParams(location.search).get("p")) || 1;
  const currentPage = pages[partParam - 1] || pages[0] || null;
  const cid = currentPage?.cid || videoData.cid || "";

  const durationSeconds = currentPage?.duration || videoData.duration || 0;
  const duration = durationSeconds
    ? `${Math.round(durationSeconds / 60)} min`
    : "";

  const aid = videoData.aid || state?.aid || "";
  const bvid = videoData.bvid || state?.bvid || "";

  const { segments, status } = cid
    ? await fetchBiliSubtitles({ aid, bvid, cid })
    : { segments: [], status: "empty" };
  const transcript = buildBiliTranscript(segments);
  const lastAvailableSeconds = segments.length
    ? segments[segments.length - 1].start
    : 0;

  const cleanedDescription = truncateVideoDescription(
    cleanBiliDescription(description),
    transcript,
  );

  let content = `Video Title:\n${title}\n`;
  if (channel) content += `\nUploader: ${channel}\n`;
  if (duration) content += `\nDuration: ${duration}\n`;
  if (cleanedDescription) content += `\nDescription:\n${cleanedDescription}\n`;
  if (transcript) {
    content += `\nLast transcript timestamp: ${formatVideoTimestamp(lastAvailableSeconds)} (${Math.floor(lastAvailableSeconds)}s)\n\nTranscript:\n${transcript}\n`;
  } else if (status === "denied") {
    content +=
      "\n(Subtitles unavailable: permission to read Bilibili was denied. Click Summarize again and choose Allow to enable subtitles.)\n";
  } else if (status === "network-error") {
    content +=
      "\n(Subtitles unavailable: network error fetching subtitles. Check your connection and try again.)\n";
  } else {
    content += "\n(No subtitles/captions available for this video.)\n";
  }

  return {
    type: "bilibili",
    title,
    url: location.href,
    content,
    durationSeconds,
  };
}
