# TwinMind

Single-page app for **live meeting copilot** behavior: microphone audio is chunked and sent to **Groq Whisper Large V3** for transcription; **Groq `openai/gpt-oss-120b`** produces structured JSON for **three on-card suggestions** and for **detailed answers** in the session chat. The API key stays in the browser (localStorage); the small Node server only proxies requests to Groq so the key is not embedded in static hosting.

## Quick start

Requirements: **Node.js 18+** (global `fetch`, `AbortSignal.timeout`, `FormData` / `Blob` for multipart transcription).

```bash
cd /path/to/TwinMind
npm start
```

Open `http://127.0.0.1:3000` (or the port printed in the terminal). Add your **Groq API key** in Settings, then start the mic.

Health check: `GET /api/health` returns model names and `{ ok: true }`.

## How it works

1. **Audio** — `MediaRecorder` captures mono audio. On a fixed interval (default 30s, configurable), the client calls `requestData()` and POSTs each blob to `POST /api/audio/transcriptions`, which forwards multipart form data to Groq.
2. **Transcript** — Each returned segment is appended as a timestamped chunk in the left panel.
3. **Suggestions** — After new transcript text arrives, an **auto** suggestion run is **debounced** (default 650ms) so back-to-back chunks do not cancel each other’s in-flight Groq calls. **Reload suggestions** runs immediately and clears any pending debounce. The model receives the recent transcript window, recent chat turns, and **the last batch’s three previews** so it can avoid repeating stale cards when the conversation has not moved.
4. **Detailed answers** — Clicking a suggestion records a user turn and calls the same chat proxy with the expanded-answer prompt and a wider transcript + chat window. Typed questions use the chat prompt. Replies are **non-streaming** JSON (title, sections, bullets, context note) for reliable parsing; the UI shows a typing indicator until the full object returns.

## Configuration

All prompts, context sizes (transcript chunks and chat turns), temperature, max tokens, and reasoning effort are editable in **Settings** and persisted under `twinmind.settings.v2` in `localStorage`.

## Privacy and security

- The server does **not** store transcripts or keys; it forwards headers and body to Groq.
- Treat your Groq key like a password; anyone with access to the running app in your browser profile can export or reuse it from devtools.

## Latency notes

- End-to-end suggestion latency is dominated by **Whisper** then **chat** round-trips; debouncing trades a sub-second delay for fewer aborted runs when multiple chunks finish close together.
- Chat and suggestions use `response_format: json_object` on the server, so **token streaming** is not used; time-to-first-visible-token equals time-to-full-JSON.

## Project layout

| File        | Role                                                                 |
| ----------- | -------------------------------------------------------------------- |
| `server.js` | Static file host + `/api/chat/completions` + `/api/audio/transcriptions` proxies |
| `app.js`    | UI, state, prompts, Groq client calls                                |
| `index.html`| Layout and settings form                                              |
| `styles.css`| Styling                                                               |
