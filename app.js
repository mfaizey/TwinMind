const GROQ_CHAT_MODEL = "openai/gpt-oss-120b";
const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";
const SETTINGS_STORAGE_KEY = "twinmind.settings.v2";
const MIN_TRANSCRIPT_FOR_SUGGESTIONS = 24;
const AUTO_SUGGESTION_DEBOUNCE_MS = 650;
const TRANSCRIPT_RICH_FOR_KIND_MIX = 100;

const DEFAULT_SETTINGS = {
  apiKey: "",
  transcriptionLanguage: "en",
  transcriptionPrompt:
    "This is a live conversation. Preserve product names, acronyms, technical terms, and speaker wording when they are clear.",
  transcriptionChunkSeconds: 30,
  liveSuggestionPrompt: `
You are TwinMind, a real-time live conversation copilot.

Read the provided transcript and recent session context, then produce exactly 3 suggestions the user can use in the next 30 seconds.

Goals:
- Be specific to the provided transcript.
- Maximize immediate usefulness in a live room.
- Prefer a mix of suggestion kinds when justified by the context: question, talking-point, answer, fact-check.
- Use fact-check when a claim depends on dates, freshness, metrics, sources, or uncertain assumptions.
- Never invent external facts.
- Keep every suggestion concise and natural.

Return strict JSON only in this shape:
{
  "summary": "one sentence about what the conversation is really about",
  "suggestions": [
    {
      "kind": "question",
      "label": "short label",
      "preview": "what the user should ask or say right now, max 140 characters",
      "why_now": "one short sentence about why this is timely"
    }
  ]
}

Rules:
- Exactly 3 suggestions.
- Allowed kinds: question, talking-point, answer, fact-check.
- Make all 3 suggestions distinct and non-overlapping.
- No markdown.
- No code fences.
- If the context is thin, make the suggestions clarify the conversation instead of pretending certainty.
- If "Recent suggestion previews" are provided, do not repeat or lightly rephrase them unless the latest transcript clearly changes the best move.
  `.trim(),
  liveSuggestionContextChunks: 4,
  liveSuggestionChatTurns: 6,
  liveSuggestionTemperature: 0.3,
  liveSuggestionMaxTokens: 650,
  liveSuggestionReasoning: "low",
  expandedAnswerPrompt: `
You are TwinMind, a live conversation copilot.

The user clicked a suggested move and wants a deeper response they can use immediately.
Ground the answer in the provided transcript and session chat.
Open with one short, speakable sentence they can say verbatim when that helps, then unpack.
Write something concrete enough to say in the room, not generic analysis.
Separate strong observations from assumptions.
If a claim is time-sensitive or not verifiable from context, say what should be verified before anyone treats it as settled.
End with an action-oriented next move.

Return strict JSON only in this shape:
{
  "title": "short heading",
  "sections": ["2 to 4 short paragraphs"],
  "bullets": ["up to 3 concise bullets"],
  "contextNote": "one short line describing what context you used"
}

Rules:
- No markdown.
- No code fences.
- Keep the answer concise and high-signal.
- Do not invent facts that are not in the provided context.
  `.trim(),
  expandedAnswerContextChunks: 8,
  expandedAnswerChatTurns: 6,
  expandedAnswerTemperature: 0.45,
  expandedAnswerMaxTokens: 900,
  expandedAnswerReasoning: "medium",
  chatPrompt: `
You are TwinMind's session chat assistant.

Answer using the supplied transcript and recent session chat as primary context.
Be direct, useful, and grounded.
If the user asks for a summary, compress clearly.
If they ask for actions, surface concrete next steps and owners when available.
If the answer is not supported by context, say what is missing instead of hallucinating.
If the question depends on up-to-date external facts, note that the claim should be verified before it becomes part of the plan.

Return strict JSON only in this shape:
{
  "title": "short heading",
  "sections": ["2 to 4 short paragraphs"],
  "bullets": ["up to 3 concise bullets"],
  "contextNote": "one short line describing what context you used"
}

Rules:
- No markdown.
- No code fences.
- Prefer concise, specific language over long essays.
- Do not restate the full transcript.
  `.trim(),
  chatTranscriptContextChunks: 10,
  chatHistoryTurns: 8,
  chatTemperature: 0.4,
  chatMaxTokens: 1000,
  chatReasoning: "medium",
};

const state = {
  settings: loadSettings(),
  transcriptChunks: [],
  suggestionBatches: [],
  chatHistory: [],
  isListening: false,
  mediaStream: null,
  mediaRecorder: null,
  nextChunkAt: null,
  chunkTimerId: null,
  countdownTimerId: null,
  transcriptionQueue: [],
  transcriptionInFlight: false,
  pendingRecorderStop: false,
  suggestionAbortController: null,
  suggestionRequestId: 0,
  suggestionError: "",
  suggestionDebounceTimerId: null,
  loadingSuggestions: false,
  activeChatRequest: null,
  sessionStartedAt: new Date(),
  micMimeType: "",
};

const elements = {
  autoRefreshMeta: document.getElementById("autoRefreshMeta"),
  batchCount: document.getElementById("batchCount"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  chatMessages: document.getElementById("chatMessages"),
  chatSendButton: document.getElementById("chatSendButton"),
  chatSessionMeta: document.getElementById("chatSessionMeta"),
  clearChatButton: document.getElementById("clearChatButton"),
  closeSettingsButton: document.getElementById("closeSettingsButton"),
  exportButton: document.getElementById("exportButton"),
  livePreview: document.getElementById("livePreview"),
  micSummary: document.getElementById("micSummary"),
  chunkMeta: document.getElementById("chunkMeta"),
  reloadSuggestionsButton: document.getElementById("reloadSuggestionsButton"),
  restoreDefaultsButton: document.getElementById("restoreDefaultsButton"),
  saveSettingsButton: document.getElementById("saveSettingsButton"),
  settingsBanner: document.getElementById("settingsBanner"),
  settingsButton: document.getElementById("settingsButton"),
  settingsForm: document.getElementById("settingsForm"),
  settingsModal: document.getElementById("settingsModal"),
  statusPill: document.getElementById("statusPill"),
  suggestionBatches: document.getElementById("suggestionBatches"),
  supportBadge: document.getElementById("supportBadge"),
  toggleButton: document.getElementById("toggleButton"),
  toggleButtonText: document.getElementById("toggleButtonText"),
  transcriptFeed: document.getElementById("transcriptFeed"),
};

initialize();

function initialize() {
  state.micMimeType = getPreferredRecorderMimeType();

  elements.toggleButton.addEventListener("click", handleToggleListening);
  elements.reloadSuggestionsButton.addEventListener("click", handleManualSuggestionReload);
  elements.clearChatButton.addEventListener("click", handleClearChat);
  elements.chatInput.addEventListener("input", updateControls);
  elements.chatForm.addEventListener("submit", handleChatSubmit);
  elements.exportButton.addEventListener("click", exportSession);
  elements.settingsButton.addEventListener("click", () => openSettings());
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.restoreDefaultsButton.addEventListener("click", handleRestoreDefaults);
  elements.settingsForm.addEventListener("submit", handleSaveSettings);
  elements.settingsModal.addEventListener("click", handleSettingsBackdropClick);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.settingsModal.hidden) {
      closeSettings();
    }
  });

  syncSettingsForm();
  resetChat();
  renderTranscriptFeed();
  renderSuggestionBatches();
  updateBatchCount();
  updateAutoRefreshMeta();
  updateChatMeta();
  updateControls();
  updateMicSummary();
  updateSupportBadge();

  if (!supportsAudioCapture()) {
    setStatus("Unsupported", "error");
    elements.micSummary.textContent =
      "Audio capture is unavailable here. Open this app in a recent Chrome, Edge, or Safari build.";
    elements.supportBadge.textContent =
      "MediaRecorder is required so we can send recorded audio chunks to Groq Whisper Large V3.";
    return;
  }

  if (!state.settings.apiKey) {
    setStatus("Add API key", "warning");
  } else {
    setStatus("Ready", "ready");
  }
}

function supportsAudioCapture() {
  return Boolean(
    navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      window.MediaRecorder,
  );
}

function getPreferredRecorderMimeType() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

function handleSettingsBackdropClick(event) {
  if (event.target.dataset.closeSettings === "true") {
    closeSettings();
  }
}

function openSettings(message = "") {
  syncSettingsForm();
  setSettingsBanner(message);
  elements.settingsModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeSettings() {
  elements.settingsModal.hidden = true;
  document.body.classList.remove("modal-open");
  setSettingsBanner("");
}

function setSettingsBanner(message) {
  const value = normalizeWhitespace(message);
  elements.settingsBanner.hidden = !value;
  elements.settingsBanner.textContent = value;
}

function handleRestoreDefaults() {
  const apiKey = normalizeWhitespace(getSettingsFieldValue("apiKey"));
  const restored = { ...DEFAULT_SETTINGS, apiKey };
  populateSettingsForm(restored);
  setSettingsBanner("Default prompts and parameters restored. Save to apply them.");
}

function handleSaveSettings(event) {
  event.preventDefault();

  const nextSettings = readSettingsFromForm();
  const previousChunkSeconds = state.settings.transcriptionChunkSeconds;
  const hadApiKey = Boolean(state.settings.apiKey);

  state.settings = nextSettings;
  persistSettings(state.settings);
  syncSettingsForm();

  if (!hadApiKey && state.settings.apiKey) {
    setStatus("Ready", "ready");
  }

  if (!state.settings.apiKey) {
    setStatus("Add API key", "warning");
  }

  if (state.isListening && previousChunkSeconds !== state.settings.transcriptionChunkSeconds) {
    restartChunkClock();
  } else {
    updateAutoRefreshMeta();
  }

  updateControls();
  updateMicSummary();
  closeSettings();
}

function readSettingsFromForm() {
  const formData = new FormData(elements.settingsForm);

  return sanitizeSettings({
    apiKey: formData.get("apiKey"),
    transcriptionLanguage: formData.get("transcriptionLanguage"),
    transcriptionPrompt: formData.get("transcriptionPrompt"),
    transcriptionChunkSeconds: formData.get("transcriptionChunkSeconds"),
    liveSuggestionPrompt: formData.get("liveSuggestionPrompt"),
    liveSuggestionContextChunks: formData.get("liveSuggestionContextChunks"),
    liveSuggestionChatTurns: formData.get("liveSuggestionChatTurns"),
    liveSuggestionTemperature: formData.get("liveSuggestionTemperature"),
    liveSuggestionMaxTokens: formData.get("liveSuggestionMaxTokens"),
    liveSuggestionReasoning: formData.get("liveSuggestionReasoning"),
    expandedAnswerPrompt: formData.get("expandedAnswerPrompt"),
    expandedAnswerContextChunks: formData.get("expandedAnswerContextChunks"),
    expandedAnswerChatTurns: formData.get("expandedAnswerChatTurns"),
    expandedAnswerTemperature: formData.get("expandedAnswerTemperature"),
    expandedAnswerMaxTokens: formData.get("expandedAnswerMaxTokens"),
    expandedAnswerReasoning: formData.get("expandedAnswerReasoning"),
    chatPrompt: formData.get("chatPrompt"),
    chatTranscriptContextChunks: formData.get("chatTranscriptContextChunks"),
    chatHistoryTurns: formData.get("chatHistoryTurns"),
    chatTemperature: formData.get("chatTemperature"),
    chatMaxTokens: formData.get("chatMaxTokens"),
    chatReasoning: formData.get("chatReasoning"),
  });
}

function syncSettingsForm() {
  populateSettingsForm(state.settings);
}

function populateSettingsForm(settings) {
  setSettingsFieldValue("apiKey", settings.apiKey);
  setSettingsFieldValue("transcriptionLanguage", settings.transcriptionLanguage);
  setSettingsFieldValue("transcriptionPrompt", settings.transcriptionPrompt);
  setSettingsFieldValue("transcriptionChunkSeconds", String(settings.transcriptionChunkSeconds));
  setSettingsFieldValue("liveSuggestionPrompt", settings.liveSuggestionPrompt);
  setSettingsFieldValue("liveSuggestionContextChunks", String(settings.liveSuggestionContextChunks));
  setSettingsFieldValue("liveSuggestionChatTurns", String(settings.liveSuggestionChatTurns));
  setSettingsFieldValue("liveSuggestionTemperature", String(settings.liveSuggestionTemperature));
  setSettingsFieldValue("liveSuggestionMaxTokens", String(settings.liveSuggestionMaxTokens));
  setSettingsFieldValue("liveSuggestionReasoning", settings.liveSuggestionReasoning);
  setSettingsFieldValue("expandedAnswerPrompt", settings.expandedAnswerPrompt);
  setSettingsFieldValue("expandedAnswerContextChunks", String(settings.expandedAnswerContextChunks));
  setSettingsFieldValue("expandedAnswerChatTurns", String(settings.expandedAnswerChatTurns));
  setSettingsFieldValue("expandedAnswerTemperature", String(settings.expandedAnswerTemperature));
  setSettingsFieldValue("expandedAnswerMaxTokens", String(settings.expandedAnswerMaxTokens));
  setSettingsFieldValue("expandedAnswerReasoning", settings.expandedAnswerReasoning);
  setSettingsFieldValue("chatPrompt", settings.chatPrompt);
  setSettingsFieldValue("chatTranscriptContextChunks", String(settings.chatTranscriptContextChunks));
  setSettingsFieldValue("chatHistoryTurns", String(settings.chatHistoryTurns));
  setSettingsFieldValue("chatTemperature", String(settings.chatTemperature));
  setSettingsFieldValue("chatMaxTokens", String(settings.chatMaxTokens));
  setSettingsFieldValue("chatReasoning", settings.chatReasoning);
}

function setSettingsFieldValue(name, value) {
  const field = elements.settingsForm.elements.namedItem(name);

  if (field) {
    field.value = value;
  }
}

function getSettingsFieldValue(name) {
  const field = elements.settingsForm.elements.namedItem(name);
  return field ? field.value : "";
}

async function handleToggleListening() {
  if (state.pendingRecorderStop) {
    setStatus("Finishing chunk", "warning");
    return;
  }

  if (state.isListening) {
    await stopListening();
    return;
  }

  await startListening();
}

async function startListening() {
  if (!supportsAudioCapture()) {
    setStatus("Unsupported", "error");
    return;
  }

  if (!ensureApiKey("Add your Groq API key before starting Whisper transcription.")) {
    return;
  }

  try {
    if (!hasSessionContent()) {
      state.sessionStartedAt = new Date();
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const recorder = state.micMimeType
      ? new MediaRecorder(stream, { mimeType: state.micMimeType })
      : new MediaRecorder(stream);

    recorder.addEventListener("dataavailable", handleRecorderDataAvailable);
    recorder.addEventListener("stop", handleRecorderStopped);
    recorder.addEventListener("error", handleRecorderError);

    state.mediaStream = stream;
    state.mediaRecorder = recorder;
    state.isListening = true;
    state.pendingRecorderStop = false;
    state.suggestionError = "";

    recorder.start();
    startChunkClock();
    updateMicSummary();
    updateSupportBadge();
    renderTranscriptFeed();
    renderSuggestionBatches();
    updateControls();
    setStatus("Listening", "ready");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Microphone access failed.", "error");
    cleanupRecorderResources();
    updateMicSummary();
    updateControls();
  }
}

async function stopListening() {
  if (!state.mediaRecorder) {
    state.isListening = false;
    clearSuggestionDebounce();
    stopChunkClock();
    updateMicSummary();
    updateControls();
    return;
  }

  state.isListening = false;
  clearSuggestionDebounce();
  state.pendingRecorderStop = true;
  stopChunkClock();
  updateMicSummary();
  updateControls();
  setStatus("Finishing chunk", "warning");

  try {
    if (state.mediaRecorder.state !== "inactive") {
      state.mediaRecorder.stop();
    }
  } catch (error) {
    console.error(error);
    finalizeRecorderStop();
  }
}

function handleRecorderDataAvailable(event) {
  if (!event.data || event.data.size === 0) {
    return;
  }

  state.transcriptionQueue.push({
    blob: event.data,
    createdAt: new Date(),
  });
  renderTranscriptFeed();
  updateMicSummary();
  void drainTranscriptionQueue();
}

function handleRecorderStopped() {
  if (!state.transcriptionInFlight && state.transcriptionQueue.length === 0) {
    finalizeRecorderStop();
  }
}

function handleRecorderError(event) {
  const message = event?.error?.message || event?.error?.name || "Recording failed.";
  console.error(event?.error || event);
  clearSuggestionDebounce();
  setStatus(message, "error");
  cleanupRecorderResources();
  state.isListening = false;
  state.pendingRecorderStop = false;
  stopChunkClock();
  updateMicSummary();
  updateControls();
  renderTranscriptFeed();
}

function startChunkClock() {
  stopChunkClock();
  resetChunkCountdown();

  state.chunkTimerId = window.setInterval(() => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
      return;
    }

    try {
      state.mediaRecorder.requestData();
      resetChunkCountdown();
    } catch (error) {
      console.error(error);
      setStatus("Chunk request failed", "error");
    }
  }, state.settings.transcriptionChunkSeconds * 1000);

  state.countdownTimerId = window.setInterval(updateAutoRefreshMeta, 1000);
}

function restartChunkClock() {
  if (!state.isListening || !state.mediaRecorder) {
    updateAutoRefreshMeta();
    return;
  }

  startChunkClock();
}

function stopChunkClock() {
  clearInterval(state.chunkTimerId);
  clearInterval(state.countdownTimerId);
  state.chunkTimerId = null;
  state.countdownTimerId = null;
  state.nextChunkAt = null;
  updateAutoRefreshMeta();
}

function resetChunkCountdown() {
  state.nextChunkAt = Date.now() + state.settings.transcriptionChunkSeconds * 1000;
  updateAutoRefreshMeta();
}

function updateAutoRefreshMeta() {
  const intervalSeconds = state.settings.transcriptionChunkSeconds;

  if (state.loadingSuggestions) {
    elements.autoRefreshMeta.textContent = "generating suggestions...";
  } else if (state.isListening && state.nextChunkAt) {
    const remainingSeconds = Math.max(1, Math.ceil((state.nextChunkAt - Date.now()) / 1000));
    elements.autoRefreshMeta.textContent = `next Groq refresh in ${remainingSeconds}s`;
  } else {
    elements.autoRefreshMeta.textContent = `refreshes every ${intervalSeconds}s while recording`;
  }

  if (state.isListening && state.nextChunkAt) {
    const remainingSeconds = Math.max(1, Math.ceil((state.nextChunkAt - Date.now()) / 1000));
    elements.chunkMeta.textContent = `Next Whisper chunk upload in about ${remainingSeconds}s.`;
  } else if (state.pendingRecorderStop || state.transcriptionInFlight || state.transcriptionQueue.length) {
    elements.chunkMeta.textContent = "Waiting for the final Whisper chunk to finish processing.";
  } else {
    elements.chunkMeta.textContent = `Transcription uploads every ${intervalSeconds}s while the mic is live.`;
  }
}

async function drainTranscriptionQueue() {
  if (state.transcriptionInFlight) {
    return;
  }

  state.transcriptionInFlight = true;
  updateMicSummary();
  renderTranscriptFeed();

  while (state.transcriptionQueue.length) {
    const segment = state.transcriptionQueue.shift();

    try {
      const transcriptText = await transcribeAudioSegment(segment.blob);

      if (transcriptText) {
        appendTranscriptChunk(transcriptText, segment.createdAt);
        scheduleAutoSuggestionGeneration();
      }
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Transcription failed.", "error");
    }
  }

  state.transcriptionInFlight = false;
  updateMicSummary();
  renderTranscriptFeed();

  if (state.pendingRecorderStop && state.transcriptionQueue.length === 0) {
    finalizeRecorderStop();
  }
}

async function transcribeAudioSegment(blob) {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch("/api/audio/transcriptions", {
        method: "POST",
        headers: {
          "Content-Type": blob.type || state.micMimeType || "audio/webm",
          "x-file-name": `segment-${Date.now()}.${getAudioExtension(blob.type || state.micMimeType)}`,
          "x-groq-api-key": state.settings.apiKey,
          "x-language": state.settings.transcriptionLanguage,
          "x-transcription-prompt-b64": encodeBase64Utf8(state.settings.transcriptionPrompt),
        },
        body: blob,
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = data.error || "Groq transcription failed.";
        const retriable =
          ((response.status >= 500 && response.status <= 599) || response.status === 429) && attempt === 0;

        if (retriable) {
          lastError = new Error(message);
          await new Promise((resolve) => window.setTimeout(resolve, 450 * (attempt + 1)));
          continue;
        }

        throw new Error(message);
      }

      return normalizeWhitespace(data.text);
    } catch (error) {
      lastError = error;
      const message = error?.message || "";
      const networkLike =
        error?.name === "TypeError" || /network|fetch|load failed|failed to fetch/i.test(message);

      if (networkLike && attempt === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 450 * (attempt + 1)));
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("Groq transcription failed.");
}

function getAudioExtension(mimeType) {
  const normalized = (mimeType || "").toLowerCase();

  if (normalized.includes("mp4") || normalized.includes("m4a")) {
    return "m4a";
  }

  if (normalized.includes("ogg")) {
    return "ogg";
  }

  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return "mp3";
  }

  if (normalized.includes("wav")) {
    return "wav";
  }

  return "webm";
}

function appendTranscriptChunk(text, createdAt = new Date()) {
  const normalized = normalizeWhitespace(text);

  if (!normalized) {
    return;
  }

  state.transcriptChunks.push({
    id: `chunk-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt,
    text: normalized,
  });

  renderTranscriptFeed();
  updateControls();
}

function finalizeRecorderStop() {
  clearSuggestionDebounce();
  cleanupRecorderResources();
  state.isListening = false;
  state.pendingRecorderStop = false;
  stopChunkClock();
  updateMicSummary();
  updateSupportBadge();
  updateControls();
  renderTranscriptFeed();

  if (state.settings.apiKey) {
    setStatus("Ready", "ready");
  } else {
    setStatus("Add API key", "warning");
  }
}

function cleanupRecorderResources() {
  if (state.mediaRecorder) {
    state.mediaRecorder.removeEventListener("dataavailable", handleRecorderDataAvailable);
    state.mediaRecorder.removeEventListener("stop", handleRecorderStopped);
    state.mediaRecorder.removeEventListener("error", handleRecorderError);
  }

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
  }

  state.mediaRecorder = null;
  state.mediaStream = null;
}

async function handleManualSuggestionReload() {
  if (!ensureApiKey("Add your Groq API key before generating suggestions.")) {
    return;
  }

  clearSuggestionDebounce();
  await runSuggestionGeneration("manual");
}

function clearSuggestionDebounce() {
  if (state.suggestionDebounceTimerId) {
    window.clearTimeout(state.suggestionDebounceTimerId);
    state.suggestionDebounceTimerId = null;
  }
}

function scheduleAutoSuggestionGeneration() {
  clearSuggestionDebounce();

  state.suggestionDebounceTimerId = window.setTimeout(() => {
    state.suggestionDebounceTimerId = null;
    void runSuggestionGeneration("auto");
  }, AUTO_SUGGESTION_DEBOUNCE_MS);
}

async function runSuggestionGeneration(source) {
  const transcriptWindow = buildTranscriptWindow(state.settings.liveSuggestionContextChunks);

  if (transcriptWindow.length < MIN_TRANSCRIPT_FOR_SUGGESTIONS) {
    state.suggestionError = "";
    renderSuggestionBatches();
    updateControls();
    return false;
  }

  if (state.suggestionAbortController) {
    state.suggestionAbortController.abort();
  }

  const controller = new AbortController();
  const requestId = ++state.suggestionRequestId;
  state.suggestionAbortController = controller;
  state.loadingSuggestions = true;
  state.suggestionError = "";
  updateAutoRefreshMeta();
  renderSuggestionBatches();

  try {
    const payload = await requestStructuredGroqJson({
      messages: buildLiveSuggestionMessages(transcriptWindow, source),
      temperature: state.settings.liveSuggestionTemperature,
      maxCompletionTokens: state.settings.liveSuggestionMaxTokens,
      reasoningEffort: state.settings.liveSuggestionReasoning,
      signal: controller.signal,
    });

    if (requestId !== state.suggestionRequestId) {
      return false;
    }

    const normalized = normalizeSuggestionPayload(payload, transcriptWindow);

    state.suggestionBatches.unshift({
      id: `batch-${Date.now()}`,
      createdAt: new Date(),
      source,
      summary: normalized.summary,
      transcriptExcerpt: ellipsize(transcriptWindow.replace(/\s+/g, " ").trim(), 320),
      suggestions: normalized.suggestions.map((suggestion, index) => ({
        id: `${suggestion.kind}-${Date.now()}-${index}`,
        kind: suggestion.kind,
        label: suggestion.label,
        preview: suggestion.preview,
        whyNow: suggestion.whyNow,
      })),
    });

    state.suggestionBatches = state.suggestionBatches.slice(0, 8);
    renderSuggestionBatches();
    updateControls();
    return true;
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      state.suggestionError = error.message || "Suggestion generation failed.";
      if (source === "manual") {
        setStatus(state.suggestionError, "error");
      }
      renderSuggestionBatches();
    }

    return false;
  } finally {
    if (requestId === state.suggestionRequestId) {
      state.loadingSuggestions = false;
      state.suggestionAbortController = null;
      updateAutoRefreshMeta();
      updateControls();
    }
  }
}

function buildLiveSuggestionMessages(transcriptWindow, source) {
  const chatTurns = state.settings.liveSuggestionChatTurns;

  return [
    {
      role: "system",
      content: state.settings.liveSuggestionPrompt,
    },
    {
      role: "user",
      content: [
        "Generate live suggestions for the current conversation state.",
        `Refresh source: ${source}.`,
        `Locked models: transcription=${GROQ_TRANSCRIPTION_MODEL}, suggestions=${GROQ_CHAT_MODEL}.`,
        `Recent transcript window (${state.settings.liveSuggestionContextChunks} chunks):\n${transcriptWindow}`,
        `Recent session chat (${Math.min(chatTurns, state.chatHistory.length)} of ${chatTurns} turns):\n${buildChatContextBlock(
          chatTurns,
        )}`,
        `Recent suggestion previews to avoid repeating unless the transcript changed the move:\n${buildRecentSuggestionPreviewsBlock()}`,
      ].join("\n\n"),
    },
  ];
}

function buildRecentSuggestionPreviewsBlock() {
  const latest = state.suggestionBatches[0];

  if (!latest?.suggestions?.length) {
    return "(none yet)";
  }

  return latest.suggestions
    .map((suggestion, index) => `${index + 1}. [${suggestion.kind}] ${suggestion.preview}`)
    .join("\n");
}

function normalizeSuggestionPayload(payload, transcriptWindow) {
  const summary =
    normalizeWhitespace(payload?.summary) || "The conversation is still forming, so the suggestions lean clarifying.";
  const suggestions = [];
  const seenPreviews = new Set();
  const rawSuggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];

  rawSuggestions.forEach((item) => {
    const suggestion = normalizeSuggestion(item);

    if (!suggestion || seenPreviews.has(suggestion.preview)) {
      return;
    }

    seenPreviews.add(suggestion.preview);
    suggestions.push(suggestion);
  });

  while (suggestions.length < 3) {
    const fallback = buildFallbackSuggestion(suggestions.length);

    if (!seenPreviews.has(fallback.preview)) {
      seenPreviews.add(fallback.preview);
      suggestions.push(fallback);
    }
  }

  const trimmedWindow = transcriptWindow.replace(/\s+/g, " ").trim();
  const diversified = ensureDiverseSuggestionKinds(suggestions.slice(0, 3), trimmedWindow);

  return {
    summary,
    suggestions: diversified,
  };
}

function ensureDiverseSuggestionKinds(suggestions, transcriptText) {
  if (!suggestions.length || transcriptText.length < TRANSCRIPT_RICH_FOR_KIND_MIX) {
    return suggestions;
  }

  const kinds = new Set(suggestions.map((suggestion) => suggestion.kind));

  if (kinds.size >= 2) {
    return suggestions;
  }

  const [first, ...rest] = suggestions;
  const seen = new Set([first.preview]);
  const alternates = [buildFallbackSuggestion(0), buildFallbackSuggestion(1), buildFallbackSuggestion(2)].filter(
    (fallback) => fallback.kind !== first.kind,
  );
  const next = [first];

  alternates.forEach((fallback) => {
    if (next.length === 3) {
      return;
    }

    if (!seen.has(fallback.preview)) {
      seen.add(fallback.preview);
      next.push(fallback);
    }
  });

  rest.forEach((suggestion) => {
    if (next.length === 3) {
      return;
    }

    if (!seen.has(suggestion.preview)) {
      seen.add(suggestion.preview);
      next.push(suggestion);
    }
  });

  while (next.length < 3) {
    const filler = buildFallbackSuggestion(next.length);

    if (!seen.has(filler.preview)) {
      seen.add(filler.preview);
      next.push(filler);
    } else {
      break;
    }
  }

  return next.length === 3 ? next : suggestions;
}

function normalizeSuggestion(item) {
  const preview = ellipsize(normalizeWhitespace(item?.preview), 140);

  if (!preview) {
    return null;
  }

  const kind = normalizeSuggestionKind(item?.kind);
  const label = ellipsize(normalizeWhitespace(item?.label) || fallbackLabelForKind(kind), 28);
  const whyNow = ellipsize(
    normalizeWhitespace(item?.why_now || item?.whyNow) || "Useful because it sharpens the next move in the room.",
    120,
  );

  return {
    kind,
    label,
    preview,
    whyNow,
  };
}

function buildFallbackSuggestion(index) {
  const fallbacks = [
    {
      kind: "question",
      label: "Clarify",
      preview: "Ask: What decision do we need before this conversation ends?",
      whyNow: "This helps the room converge on one outcome.",
    },
    {
      kind: "talking-point",
      label: "Recenter",
      preview: "Talking point: Let's restate the goal, blocker, and owner in one sentence.",
      whyNow: "This turns a drifting conversation into an actionable thread.",
    },
    {
      kind: "fact-check",
      label: "Verify",
      preview: "Fact-check: Confirm the latest date, metric, or source before it becomes the plan.",
      whyNow: "This prevents the room from locking onto a stale assumption.",
    },
  ];

  return fallbacks[index] || fallbacks[0];
}

function normalizeSuggestionKind(kind) {
  const value = normalizeWhitespace(kind).toLowerCase();

  if (["question", "talking-point", "answer", "fact-check"].includes(value)) {
    return value;
  }

  if (value.includes("talk")) {
    return "talking-point";
  }

  if (value.includes("fact") || value.includes("verify")) {
    return "fact-check";
  }

  if (value.includes("question")) {
    return "question";
  }

  return "answer";
}

function fallbackLabelForKind(kind) {
  if (kind === "question") {
    return "Question";
  }

  if (kind === "talking-point") {
    return "Talking Point";
  }

  if (kind === "fact-check") {
    return "Fact Check";
  }

  return "Answer";
}

function renderTranscriptFeed() {
  elements.transcriptFeed.innerHTML = "";

  if (!state.transcriptChunks.length) {
    const emptyMessage = state.settings.apiKey
      ? `No transcript yet. Start the mic to capture ${state.settings.transcriptionChunkSeconds}-second Groq Whisper chunks.`
      : "Add your Groq API key in Settings, then start the mic to capture Whisper chunks.";
    elements.transcriptFeed.appendChild(createEmptyState(emptyMessage, "transcript-empty"));
  } else {
    state.transcriptChunks.forEach((chunk) => {
      elements.transcriptFeed.appendChild(createTranscriptCard(chunk));
    });
  }

  if (state.isListening || state.transcriptionInFlight || state.transcriptionQueue.length || state.pendingRecorderStop) {
    elements.transcriptFeed.appendChild(createRecorderStatusCard());
  }

  elements.livePreview.textContent = buildLivePreviewText();
  elements.livePreview.classList.toggle("active", Boolean(elements.livePreview.textContent));
  scrollContainerToBottom(elements.transcriptFeed);
}

function createTranscriptCard(chunk) {
  const card = document.createElement("article");
  card.className = "transcript-chunk";

  const label = document.createElement("p");
  label.className = "transcript-time";
  label.textContent = formatTime(chunk.createdAt);

  const body = document.createElement("p");
  body.className = "transcript-text";
  body.textContent = chunk.text;

  card.append(label, body);
  return card;
}

function createRecorderStatusCard() {
  const card = document.createElement("article");
  card.className = "transcript-chunk draft";

  const label = document.createElement("p");
  label.className = "transcript-time";
  label.textContent = state.pendingRecorderStop ? "Final chunk" : "Live recorder";

  const body = document.createElement("p");
  body.className = "transcript-text";
  body.textContent = buildRecorderStatusText();

  card.append(label, body);
  return card;
}

function buildRecorderStatusText() {
  if (state.pendingRecorderStop) {
    return "Recording stopped. Waiting for the last audio segment to finish transcription.";
  }

  if (state.transcriptionInFlight) {
    return `Whisper Large V3 is transcribing now. ${state.transcriptionQueue.length} queued segment(s) remain after this one.`;
  }

  if (state.transcriptionQueue.length) {
    return `${state.transcriptionQueue.length} recorded segment(s) are queued for Groq transcription.`;
  }

  if (state.isListening && state.nextChunkAt) {
    const remainingSeconds = Math.max(1, Math.ceil((state.nextChunkAt - Date.now()) / 1000));
    return `Recording live. The next audio chunk will upload in about ${remainingSeconds}s.`;
  }

  return "Recorder is idle.";
}

function buildLivePreviewText() {
  if (state.pendingRecorderStop) {
    return "Finishing the last Whisper chunk...";
  }

  if (state.transcriptionInFlight) {
    return "Transcribing with Groq Whisper Large V3...";
  }

  if (state.isListening) {
    return `Recording live. Transcript lands in ${state.settings.transcriptionChunkSeconds}-second Whisper chunks.`;
  }

  return "";
}

function renderSuggestionBatches() {
  elements.suggestionBatches.innerHTML = "";

  if (!state.suggestionBatches.length) {
    const message = state.loadingSuggestions
      ? "Generating suggestions from the latest transcript..."
      : state.suggestionError
        ? state.suggestionError
        : "Suggestions appear here after the first useful transcript chunk arrives.";
    const className = state.suggestionError ? "suggestions-empty error" : "suggestions-empty";
    elements.suggestionBatches.appendChild(createEmptyState(message, className));
    updateBatchCount();
    return;
  }

  state.suggestionBatches.forEach((batch, index) => {
    const batchCard = document.createElement("article");
    batchCard.className = "suggestion-batch";
    batchCard.dataset.age = String(Math.min(index, 3));

    const header = document.createElement("div");
    header.className = "batch-header";

    const label = document.createElement("p");
    label.className = "batch-label";
    label.textContent = `${index === 0 ? "Latest batch" : `Batch ${index + 1}`} · ${
      batch.source === "manual" ? "manual refresh" : "auto refresh"
    }`;

    const time = document.createElement("time");
    time.dateTime = batch.createdAt.toISOString();
    time.textContent = formatTime(batch.createdAt);

    header.append(label, time);

    const summary = document.createElement("p");
    summary.className = "batch-summary";
    summary.textContent = batch.summary || batch.transcriptExcerpt;

    const stack = document.createElement("div");
    stack.className = "suggestion-stack";

    batch.suggestions.forEach((suggestion) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggestion-card";
      button.dataset.kind = suggestion.kind;
      button.addEventListener("click", () => handleSuggestionClick(suggestion, batch));

      const type = document.createElement("span");
      type.className = "suggestion-type";
      type.textContent = suggestion.label;

      const preview = document.createElement("p");
      preview.className = "suggestion-preview";
      preview.textContent = suggestion.preview;

      const whyNow = document.createElement("p");
      whyNow.className = "suggestion-why-now";
      whyNow.textContent = suggestion.whyNow;

      const footer = document.createElement("span");
      footer.className = "suggestion-footer";
      footer.textContent = "Tap to open the detailed answer in chat";

      button.append(type, preview, whyNow, footer);
      stack.appendChild(button);
    });

    batchCard.append(header, summary, stack);
    elements.suggestionBatches.appendChild(batchCard);
  });

  updateBatchCount();
}

async function handleSuggestionClick(suggestion, batch) {
  if (!ensureApiKey("Add your Groq API key before opening detailed answers.")) {
    return;
  }

  appendMessageCard({
    role: "user",
    label: "Selected",
    title: suggestion.label,
    paragraphs: [suggestion.preview],
  });
  recordChatMessage({
    role: "user",
    label: "Selected",
    title: suggestion.label,
    paragraphs: [suggestion.preview],
    source: "suggestion-selection",
    meta: {
      suggestionKind: suggestion.kind,
      batchSource: batch.source,
    },
  });

  await requestAssistantReply({
    fallbackTitle: suggestion.label,
    messages: buildExpandedAnswerMessages(suggestion, batch),
    temperature: state.settings.expandedAnswerTemperature,
    maxCompletionTokens: state.settings.expandedAnswerMaxTokens,
    reasoningEffort: state.settings.expandedAnswerReasoning,
    source: "suggestion-answer",
    meta: {
      suggestionKind: suggestion.kind,
      batchSource: batch.source,
      batchCreatedAt: batch.createdAt.toISOString(),
    },
  });
}

function buildExpandedAnswerMessages(suggestion, batch) {
  return [
    {
      role: "system",
      content: state.settings.expandedAnswerPrompt,
    },
    {
      role: "user",
      content: [
        "The user clicked this live suggestion.",
        `Kind: ${suggestion.kind}`,
        `Label: ${suggestion.label}`,
        `Suggestion: ${suggestion.preview}`,
        `Why now: ${suggestion.whyNow}`,
        `Suggestion batch summary: ${batch.summary || "n/a"}`,
        `Transcript excerpt captured with that batch: ${batch.transcriptExcerpt || "n/a"}`,
        `Recent transcript window (${state.settings.expandedAnswerContextChunks} chunks):\n${buildTranscriptWindow(
          state.settings.expandedAnswerContextChunks,
        )}`,
        `Recent session chat (${state.settings.expandedAnswerChatTurns} turns):\n${buildChatContextBlock(
          state.settings.expandedAnswerChatTurns,
        )}`,
      ].join("\n\n"),
    },
  ];
}

async function handleChatSubmit(event) {
  event.preventDefault();

  const question = normalizeWhitespace(elements.chatInput.value);

  if (!question) {
    return;
  }

  if (!ensureApiKey("Add your Groq API key before using session chat.")) {
    return;
  }

  elements.chatInput.value = "";
  appendMessageCard({
    role: "user",
    label: "You",
    title: "Question",
    paragraphs: [question],
  });
  recordChatMessage({
    role: "user",
    label: "You",
    title: "Question",
    paragraphs: [question],
    source: "typed-question",
    meta: {
      prompt: question,
    },
  });
  updateControls();

  await requestAssistantReply({
    fallbackTitle: question,
    messages: buildDirectChatMessages(question),
    temperature: state.settings.chatTemperature,
    maxCompletionTokens: state.settings.chatMaxTokens,
    reasoningEffort: state.settings.chatReasoning,
    source: "direct-answer",
    meta: {
      prompt: question,
    },
  });
}

function buildDirectChatMessages(question) {
  return [
    {
      role: "system",
      content: state.settings.chatPrompt,
    },
    {
      role: "user",
      content: [
        `User question: ${question}`,
        `Recent transcript window (${state.settings.chatTranscriptContextChunks} chunks):\n${buildTranscriptWindow(
          state.settings.chatTranscriptContextChunks,
        )}`,
        `Recent session chat (${state.settings.chatHistoryTurns} turns):\n${buildChatContextBlock(
          state.settings.chatHistoryTurns,
        )}`,
      ].join("\n\n"),
    },
  ];
}

async function requestAssistantReply({
  fallbackTitle,
  messages,
  temperature,
  maxCompletionTokens,
  reasoningEffort,
  source,
  meta,
}) {
  interruptActiveAssistantReply();

  const requestId = `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const controller = new AbortController();
  const pendingCard = createPendingAssistantCard(fallbackTitle);

  state.activeChatRequest = {
    id: requestId,
    controller,
    card: pendingCard.card,
    body: pendingCard.body,
    typing: pendingCard.typing,
  };
  updateControls();

  try {
    const payload = await requestStructuredGroqJson({
      messages,
      temperature,
      maxCompletionTokens,
      reasoningEffort,
      signal: controller.signal,
    });

    if (!state.activeChatRequest || state.activeChatRequest.id !== requestId) {
      return false;
    }

    const reply = normalizeStructuredReply(payload, fallbackTitle);
    fillAssistantCard(pendingCard.card, pendingCard.body, pendingCard.typing, reply);
    recordChatMessage({
      role: "assistant",
      label: "Assistant",
      title: reply.title,
      paragraphs: reply.sections,
      bullets: reply.bullets,
      context: reply.contextNote,
      source,
      meta,
    });
    state.activeChatRequest = null;
    updateControls();
    return true;
  } catch (error) {
    if (error.name === "AbortError") {
      return false;
    }

    console.error(error);

    if (state.activeChatRequest && state.activeChatRequest.id === requestId) {
      fillAssistantCard(
        pendingCard.card,
        pendingCard.body,
        pendingCard.typing,
        normalizeStructuredReply(
          {
            title: fallbackTitle,
            sections: [error.message || "The assistant reply failed."],
            bullets: [],
            contextNote: "Groq did not return a usable response for this turn.",
          },
          fallbackTitle,
        ),
        true,
      );
      state.activeChatRequest = null;
      updateControls();
    }

    return false;
  }
}

function interruptActiveAssistantReply() {
  if (!state.activeChatRequest) {
    return;
  }

  const { controller, card, body, typing } = state.activeChatRequest;
  controller.abort();
  typing.remove();

  if (!body.querySelector('[data-stream-status="interrupted"]')) {
    const note = document.createElement("p");
    note.className = "message-context";
    note.dataset.streamStatus = "interrupted";
    note.textContent = "Interrupted to answer a newer prompt in this same session.";
    body.appendChild(note);
    card.classList.add("interrupted");
  }

  state.activeChatRequest = null;
}

function createPendingAssistantCard(title) {
  clearChatEmptyState();

  const card = document.createElement("article");
  card.className = "message assistant";

  const label = document.createElement("p");
  label.className = "chat-label";
  label.textContent = "Assistant";

  const heading = document.createElement("h3");
  heading.textContent = ellipsize(title, 80);

  const body = document.createElement("div");
  body.className = "message-body";

  const typing = createTypingIndicator();
  body.appendChild(typing);

  card.append(label, heading, body);
  elements.chatMessages.appendChild(card);
  scrollContainerToBottom(elements.chatMessages);

  return { card, body, typing };
}

function fillAssistantCard(card, body, typing, reply, isError = false) {
  typing.remove();
  body.innerHTML = "";
  card.classList.toggle("error", isError);

  const heading = card.querySelector("h3");

  if (heading) {
    heading.textContent = ellipsize(reply.title, 80);
  }

  reply.sections.forEach((section) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = section;
    body.appendChild(paragraph);
  });

  if (reply.bullets.length) {
    body.appendChild(buildBulletList(reply.bullets));
  }

  if (reply.contextNote) {
    const context = document.createElement("p");
    context.className = "message-context";
    context.textContent = reply.contextNote;
    body.appendChild(context);
  }

  scrollContainerToBottom(elements.chatMessages);
}

function normalizeStructuredReply(payload, fallbackTitle) {
  const title = normalizeWhitespace(payload?.title) || ellipsize(fallbackTitle, 80) || "Reply";
  const rawSections = Array.isArray(payload?.sections)
    ? payload.sections
    : typeof payload?.answer === "string"
      ? [payload.answer]
      : Array.isArray(payload?.answer)
        ? payload.answer
        : [];
  const sections = rawSections
    .map((section) => normalizeWhitespace(section))
    .filter(Boolean)
    .slice(0, 4);
  const bullets = (Array.isArray(payload?.bullets) ? payload.bullets : [])
    .map((bullet) => ellipsize(normalizeWhitespace(bullet), 160))
    .filter(Boolean)
    .slice(0, 3);
  const contextNote = ellipsize(
    normalizeWhitespace(payload?.contextNote || payload?.context_note),
    180,
  );

  if (!sections.length) {
    sections.push("Groq returned an empty structured answer for this request.");
  }

  return {
    title,
    sections,
    bullets,
    contextNote,
  };
}

async function requestStructuredGroqJson({
  messages,
  temperature,
  maxCompletionTokens,
  reasoningEffort,
  signal,
}) {
  const response = await fetch("/api/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-groq-api-key": state.settings.apiKey,
    },
    body: JSON.stringify({
      messages,
      temperature,
      maxCompletionTokens,
      reasoningEffort,
    }),
    signal,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Groq request failed.");
  }

  return parseModelJsonContent(data.content);
}

function parseModelJsonContent(content) {
  if (typeof content !== "string") {
    return {};
  }

  const trimmed = content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    return {
      title: "Model Output",
      sections: [trimmed],
      bullets: [],
      contextNote: "",
    };
  }
}

function handleClearChat() {
  interruptActiveAssistantReply();
  state.chatHistory = [];
  elements.chatMessages.innerHTML = "";
  updateChatMeta();
  elements.chatMessages.appendChild(
    createEmptyState("Click a suggestion or type a question below.", "chat-empty"),
  );
  updateControls();
}

function resetChat() {
  state.chatHistory = [];
  elements.chatMessages.innerHTML = "";
  elements.chatMessages.appendChild(
    createEmptyState("Click a suggestion or type a question below.", "chat-empty"),
  );
}

function appendMessageCard({
  role,
  label,
  title,
  paragraphs = [],
  bullets = [],
  context = "",
  extraClass = "",
}) {
  clearChatEmptyState();

  const message = document.createElement("article");
  message.className = `message ${role}${extraClass ? ` ${extraClass}` : ""}`;

  const labelElement = document.createElement("p");
  labelElement.className = "chat-label";
  labelElement.textContent = label;

  const titleElement = document.createElement("h3");
  titleElement.textContent = ellipsize(title, 80);

  const body = document.createElement("div");
  body.className = "message-body";

  paragraphs.forEach((paragraph) => {
    const paragraphElement = document.createElement("p");
    paragraphElement.textContent = paragraph;
    body.appendChild(paragraphElement);
  });

  if (bullets.length) {
    body.appendChild(buildBulletList(bullets));
  }

  if (context) {
    const contextElement = document.createElement("p");
    contextElement.className = "message-context";
    contextElement.textContent = context;
    body.appendChild(contextElement);
  }

  message.append(labelElement, titleElement, body);
  elements.chatMessages.appendChild(message);
  scrollContainerToBottom(elements.chatMessages);
  return message;
}

function createTypingIndicator() {
  const indicator = document.createElement("div");
  indicator.className = "typing";

  for (let index = 0; index < 3; index += 1) {
    indicator.appendChild(document.createElement("span"));
  }

  return indicator;
}

function buildBulletList(items) {
  const list = document.createElement("ul");

  items.forEach((item) => {
    const bullet = document.createElement("li");
    bullet.textContent = item;
    list.appendChild(bullet);
  });

  return list;
}

function createEmptyState(message, extraClass = "") {
  const empty = document.createElement("div");
  empty.className = `empty-state${extraClass ? ` ${extraClass}` : ""}`;
  empty.textContent = message;
  return empty;
}

function clearChatEmptyState() {
  const empty = elements.chatMessages.querySelector(".empty-state");

  if (empty) {
    empty.remove();
  }
}

function recordChatMessage({
  role,
  label,
  title,
  paragraphs = [],
  bullets = [],
  context = "",
  source = "session",
  meta = {},
}) {
  const entry = {
    id: `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    role,
    label,
    title,
    paragraphs: [...paragraphs],
    bullets: [...bullets],
    context,
    source,
    meta: { ...meta },
    text: flattenMessageContent({ title, paragraphs, bullets, context }),
    createdAt: new Date(),
  };

  state.chatHistory.push(entry);
  state.chatHistory = state.chatHistory.slice(-80);
  updateChatMeta();
  updateControls();
  return entry;
}

function flattenMessageContent({ title, paragraphs = [], bullets = [], context = "" }) {
  return normalizeWhitespace([title, ...paragraphs, ...bullets, context].filter(Boolean).join(" "));
}

function updateChatMeta() {
  const turns = state.chatHistory.length;
  elements.chatSessionMeta.textContent = turns ? `${turns} turn${turns === 1 ? "" : "s"} this session` : "Session only";
}

function updateMicSummary() {
  const chunkSeconds = state.settings.transcriptionChunkSeconds;

  if (!state.settings.apiKey) {
    elements.micSummary.textContent =
      "Add your Groq API key in Settings to start recording and transcription.";
    return;
  }

  if (state.pendingRecorderStop) {
    elements.micSummary.textContent =
      "The mic is off. We are waiting for the last recorded chunk to finish in Groq Whisper Large V3.";
    return;
  }

  if (state.transcriptionInFlight) {
    elements.micSummary.textContent =
      `Recording continues while the latest ${chunkSeconds}-second chunk is being transcribed by Groq Whisper Large V3.`;
    return;
  }

  if (state.isListening) {
    elements.micSummary.textContent =
      `Mic is live. Audio uploads every ${chunkSeconds} seconds and suggestions refresh from each new transcript slice.`;
    return;
  }

  elements.micSummary.textContent =
    `Click mic to start. Audio is transcribed by Groq Whisper Large V3 every ${chunkSeconds} seconds.`;
}

function updateSupportBadge() {
  elements.supportBadge.textContent = `Models locked: ${GROQ_TRANSCRIPTION_MODEL} for transcription and ${GROQ_CHAT_MODEL} for suggestions/chat.`;
}

function updateControls() {
  const hasSessionData = hasSessionContent();
  const hasQuestion = Boolean(normalizeWhitespace(elements.chatInput.value));
  const busyChat = Boolean(state.activeChatRequest);

  elements.toggleButton.classList.toggle("listening", state.isListening);
  elements.toggleButton.setAttribute("aria-pressed", String(state.isListening));
  elements.toggleButton.title = state.isListening ? "Stop listening" : "Start listening";
  elements.toggleButtonText.textContent = state.isListening ? "Stop mic" : "Start mic";
  elements.reloadSuggestionsButton.disabled = state.loadingSuggestions;
  elements.reloadSuggestionsButton.setAttribute("aria-busy", state.loadingSuggestions ? "true" : "false");
  elements.chatSendButton.disabled = busyChat || !hasQuestion;
  elements.exportButton.disabled = !hasSessionData;
  elements.clearChatButton.hidden = state.chatHistory.length === 0;
}

function updateBatchCount() {
  const count = state.suggestionBatches.length;
  elements.batchCount.textContent = `${count} ${count === 1 ? "batch" : "batches"}`;
}

function buildTranscriptWindow(limit) {
  const chunks = state.transcriptChunks.slice(-limit);

  if (!chunks.length) {
    return "(no transcript yet)";
  }

  return chunks.map((chunk) => `[${formatTime(chunk.createdAt)}] ${chunk.text}`).join("\n");
}

function buildChatContextBlock(limit) {
  const turns = state.chatHistory.slice(-limit);

  if (!turns.length) {
    return "(no prior session chat)";
  }

  return turns
    .map((turn) => `${turn.role.toUpperCase()}: ${flattenMessageContent(turn)}`)
    .join("\n");
}

function exportSession() {
  const payload = buildExportPayload();

  if (!payload) {
    return;
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  link.href = url;
  link.download = `twinmind-session-${timestamp}.json`;
  link.click();

  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildExportPayload() {
  if (!hasSessionContent()) {
    return null;
  }

  const exportedAt = new Date();

  return {
    app: "TwinMind Live Suggestions",
    exportFormatVersion: 3,
    exportedAt: exportedAt.toISOString(),
    exportedAtDisplay: formatDateTime(exportedAt),
    models: {
      transcription: GROQ_TRANSCRIPTION_MODEL,
      suggestionsAndChat: GROQ_CHAT_MODEL,
      provider: "Groq",
    },
    settings: getSerializableSettings(),
    session: {
      startedAt: state.sessionStartedAt.toISOString(),
      startedAtDisplay: formatDateTime(state.sessionStartedAt),
      timeZone: getResolvedTimeZone(),
      transcriptChunkIntervalSeconds: state.settings.transcriptionChunkSeconds,
      transcriptChunkCount: state.transcriptChunks.length,
      suggestionBatchCount: state.suggestionBatches.length,
      chatTurnCount: state.chatHistory.length,
    },
    transcript: state.transcriptChunks.map((chunk) => ({
      id: chunk.id,
      createdAt: chunk.createdAt.toISOString(),
      createdAtDisplay: formatDateTime(chunk.createdAt),
      text: chunk.text,
    })),
    suggestionBatches: state.suggestionBatches.map((batch) => ({
      id: batch.id,
      createdAt: batch.createdAt.toISOString(),
      createdAtDisplay: formatDateTime(batch.createdAt),
      source: batch.source,
      summary: batch.summary,
      transcriptExcerpt: batch.transcriptExcerpt,
      suggestions: batch.suggestions.map((suggestion) => ({
        id: suggestion.id,
        kind: suggestion.kind,
        label: suggestion.label,
        preview: suggestion.preview,
        whyNow: suggestion.whyNow,
      })),
    })),
    chatHistory: state.chatHistory.map((entry) => ({
      id: entry.id,
      role: entry.role,
      label: entry.label,
      title: entry.title,
      paragraphs: [...entry.paragraphs],
      bullets: [...entry.bullets],
      context: entry.context,
      source: entry.source,
      meta: { ...entry.meta },
      text: entry.text,
      createdAt: entry.createdAt.toISOString(),
      createdAtDisplay: formatDateTime(entry.createdAt),
    })),
  };
}

function getSerializableSettings() {
  const { apiKey: _apiKey, ...rest } = state.settings;
  return rest;
}

function hasSessionContent() {
  return Boolean(state.transcriptChunks.length || state.suggestionBatches.length || state.chatHistory.length);
}

function ensureApiKey(message) {
  if (state.settings.apiKey) {
    return true;
  }

  setStatus("Add API key", "warning");
  openSettings(message);
  return false;
}

function loadSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }

    return sanitizeSettings(JSON.parse(raw));
  } catch (error) {
    console.error(error);
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error(error);
  }
}

function sanitizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};

  return {
    apiKey: normalizeWhitespace(source.apiKey),
    transcriptionLanguage: normalizeLanguage(source.transcriptionLanguage, DEFAULT_SETTINGS.transcriptionLanguage),
    transcriptionPrompt:
      normalizeMultilineText(source.transcriptionPrompt) || DEFAULT_SETTINGS.transcriptionPrompt,
    transcriptionChunkSeconds: clampInteger(
      source.transcriptionChunkSeconds,
      10,
      120,
      DEFAULT_SETTINGS.transcriptionChunkSeconds,
    ),
    liveSuggestionPrompt:
      normalizeMultilineText(source.liveSuggestionPrompt) || DEFAULT_SETTINGS.liveSuggestionPrompt,
    liveSuggestionContextChunks: clampInteger(
      source.liveSuggestionContextChunks,
      1,
      20,
      DEFAULT_SETTINGS.liveSuggestionContextChunks,
    ),
    liveSuggestionChatTurns: clampInteger(
      source.liveSuggestionChatTurns,
      1,
      24,
      DEFAULT_SETTINGS.liveSuggestionChatTurns,
    ),
    liveSuggestionTemperature: clampFloat(
      source.liveSuggestionTemperature,
      0,
      2,
      DEFAULT_SETTINGS.liveSuggestionTemperature,
    ),
    liveSuggestionMaxTokens: clampInteger(
      source.liveSuggestionMaxTokens,
      200,
      3000,
      DEFAULT_SETTINGS.liveSuggestionMaxTokens,
    ),
    liveSuggestionReasoning: normalizeReasoning(
      source.liveSuggestionReasoning,
      DEFAULT_SETTINGS.liveSuggestionReasoning,
    ),
    expandedAnswerPrompt:
      normalizeMultilineText(source.expandedAnswerPrompt) || DEFAULT_SETTINGS.expandedAnswerPrompt,
    expandedAnswerContextChunks: clampInteger(
      source.expandedAnswerContextChunks,
      1,
      20,
      DEFAULT_SETTINGS.expandedAnswerContextChunks,
    ),
    expandedAnswerChatTurns: clampInteger(
      source.expandedAnswerChatTurns,
      1,
      20,
      DEFAULT_SETTINGS.expandedAnswerChatTurns,
    ),
    expandedAnswerTemperature: clampFloat(
      source.expandedAnswerTemperature,
      0,
      2,
      DEFAULT_SETTINGS.expandedAnswerTemperature,
    ),
    expandedAnswerMaxTokens: clampInteger(
      source.expandedAnswerMaxTokens,
      200,
      4000,
      DEFAULT_SETTINGS.expandedAnswerMaxTokens,
    ),
    expandedAnswerReasoning: normalizeReasoning(
      source.expandedAnswerReasoning,
      DEFAULT_SETTINGS.expandedAnswerReasoning,
    ),
    chatPrompt: normalizeMultilineText(source.chatPrompt) || DEFAULT_SETTINGS.chatPrompt,
    chatTranscriptContextChunks: clampInteger(
      source.chatTranscriptContextChunks,
      1,
      24,
      DEFAULT_SETTINGS.chatTranscriptContextChunks,
    ),
    chatHistoryTurns: clampInteger(
      source.chatHistoryTurns,
      1,
      24,
      DEFAULT_SETTINGS.chatHistoryTurns,
    ),
    chatTemperature: clampFloat(source.chatTemperature, 0, 2, DEFAULT_SETTINGS.chatTemperature),
    chatMaxTokens: clampInteger(source.chatMaxTokens, 200, 4000, DEFAULT_SETTINGS.chatMaxTokens),
    chatReasoning: normalizeReasoning(source.chatReasoning, DEFAULT_SETTINGS.chatReasoning),
  };
}

function normalizeLanguage(value, fallback) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  return normalized || fallback;
}

function normalizeReasoning(value, fallback) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  return ["low", "medium", "high"].includes(normalized) ? normalized : fallback;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function clampFloat(value, min, max, fallback) {
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeMultilineText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function encodeBase64Utf8(value) {
  const text = String(value || "");

  if (!text) {
    return "";
  }

  const bytes = new TextEncoder().encode(text);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return window.btoa(binary);
}

function ellipsize(text, maxLength) {
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function scrollContainerToBottom(container) {
  window.requestAnimationFrame(() => {
    const lastChild = container.lastElementChild;

    if (lastChild) {
      lastChild.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
    }

    container.scrollTop = container.scrollHeight;
  });
}

function getResolvedTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
}

function setStatus(message, tone) {
  elements.statusPill.textContent = message;
  elements.statusPill.className = `status-pill ${tone}`;
}
