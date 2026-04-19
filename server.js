const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const GROQ_CHAT_MODEL = "openai/gpt-oss-120b";
const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";
const GROQ_CHAT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TRANSCRIPTION_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_JSON_BODY_BYTES = 512 * 1024;
const MAX_AUDIO_BODY_BYTES = 20 * 1024 * 1024;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const AUDIO_EXTENSION_BY_TYPE = {
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/webm;codecs=opus": "webm",
  "audio/mp4;codecs=mp4a.40.2": "m4a",
};

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
}

function resolvePath(urlPath) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const target = safePath === "/" ? "/index.html" : safePath;
  return path.join(ROOT, target);
}

function getGroqApiKey(req) {
  const key = req.headers["x-groq-api-key"];
  return typeof key === "string" ? key.trim() : "";
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => ({
      role: typeof message?.role === "string" ? message.role : "",
      content: typeof message?.content === "string" ? message.content : "",
    }))
    .filter((message) => message.role && message.content);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sanitizeReasoningEffort(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
}

function guessAudioFilename(contentType, requestedName = "") {
  const normalizedType = typeof contentType === "string" ? contentType.toLowerCase() : "";
  const baseName = typeof requestedName === "string" ? requestedName.trim() : "";

  if (baseName) {
    return baseName;
  }

  return `segment-${Date.now()}.${AUDIO_EXTENSION_BY_TYPE[normalizedType] || "webm"}`;
}

function decodeBase64Utf8(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  try {
    return Buffer.from(value, "base64").toString("utf8").trim();
  } catch (error) {
    return "";
  }
}

function maybeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

async function readBody(req, limitBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > limitBytes) {
      const error = new Error("Request body too large.");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const raw = await readBody(req, MAX_JSON_BODY_BYTES);

  if (!raw.length) {
    return {};
  }

  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    error.statusCode = 400;
    error.message = "Malformed JSON request body.";
    throw error;
  }
}

async function forwardGroqChatRequest(req, res) {
  const apiKey = getGroqApiKey(req);

  if (!apiKey) {
    sendJson(res, 400, { error: "Missing Groq API key." });
    return;
  }

  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
    return;
  }

  const messages = normalizeMessages(body.messages);

  if (!messages.length) {
    sendJson(res, 400, { error: "At least one chat message is required." });
    return;
  }

  const payload = {
    model: GROQ_CHAT_MODEL,
    messages,
    stream: false,
    response_format: { type: "json_object" },
    temperature: clampNumber(body.temperature, 0, 2, 0.4),
    max_completion_tokens: Math.round(clampNumber(body.maxCompletionTokens, 128, 4096, 800)),
    reasoning_effort: sanitizeReasoningEffort(body.reasoningEffort),
  };

  const upstreamSignal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(120_000)
      : undefined;

  try {
    const groqResponse = await fetch(GROQ_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: upstreamSignal,
    });
    const text = await groqResponse.text();
    const data = maybeParseJson(text);

    if (!groqResponse.ok) {
      const message =
        data?.error?.message || data?.error || text || "Groq chat request failed unexpectedly.";
      sendJson(res, groqResponse.status, { error: message });
      return;
    }

    sendJson(res, 200, {
      model: GROQ_CHAT_MODEL,
      content: data?.choices?.[0]?.message?.content || "",
      usage: data?.usage || null,
      groqRequestId: data?.x_groq?.id || null,
    });
  } catch (error) {
    sendJson(res, 502, {
      error: error.message || "Unable to reach Groq right now.",
    });
  }
}

async function forwardGroqTranscriptionRequest(req, res) {
  const apiKey = getGroqApiKey(req);

  if (!apiKey) {
    sendJson(res, 400, { error: "Missing Groq API key." });
    return;
  }

  let audioBuffer;

  try {
    audioBuffer = await readBody(req, MAX_AUDIO_BODY_BYTES);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
    return;
  }

  if (!audioBuffer.length) {
    sendJson(res, 400, { error: "Audio body is empty." });
    return;
  }

  const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "audio/webm";
  const fileName = guessAudioFilename(contentType, req.headers["x-file-name"]);
  const language =
    typeof req.headers["x-language"] === "string" ? req.headers["x-language"].trim() : "";
  const prompt = decodeBase64Utf8(req.headers["x-transcription-prompt-b64"]);

  const form = new FormData();
  form.append("model", GROQ_TRANSCRIPTION_MODEL);
  form.append("file", new Blob([audioBuffer], { type: contentType }), fileName);
  form.append("response_format", "json");
  form.append("temperature", "0");

  if (language) {
    form.append("language", language);
  }

  if (prompt) {
    form.append("prompt", prompt);
  }

  const upstreamSignal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(120_000)
      : undefined;

  try {
    const groqResponse = await fetch(GROQ_TRANSCRIPTION_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: upstreamSignal,
    });
    const text = await groqResponse.text();
    const data = maybeParseJson(text);

    if (!groqResponse.ok) {
      const message =
        data?.error?.message || data?.error || text || "Groq transcription request failed unexpectedly.";
      sendJson(res, groqResponse.status, { error: message });
      return;
    }

    sendJson(res, 200, {
      model: GROQ_TRANSCRIPTION_MODEL,
      text: data?.text || "",
      groqRequestId: data?.x_groq?.id || null,
    });
  } catch (error) {
    sendJson(res, 502, {
      error: error.message || "Unable to reach Groq right now.",
    });
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const requestPath = requestUrl.pathname;

  if (requestPath === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      groqChatModel: GROQ_CHAT_MODEL,
      groqTranscriptionModel: GROQ_TRANSCRIPTION_MODEL,
    });
    return;
  }

  if (requestPath === "/api/chat/completions" && req.method === "POST") {
    await forwardGroqChatRequest(req, res);
    return;
  }

  if (requestPath === "/api/audio/transcriptions" && req.method === "POST") {
    await forwardGroqTranscriptionRequest(req, res);
    return;
  }

  if (!["GET", "HEAD"].includes(req.method || "GET")) {
    send(res, 405, "Method Not Allowed");
    return;
  }

  const filePath = resolvePath(requestPath);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        send(res, 404, "Not Found");
        return;
      }

      send(res, 500, "Server Error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      });
      res.end();
      return;
    }

    send(res, 200, content, MIME_TYPES[extension] || "application/octet-stream");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`TwinMind app running at http://${HOST}:${PORT}`);
});
