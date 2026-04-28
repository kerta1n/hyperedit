---
title: Cloudflare Worker
type: module
source_files:
  - src/worker/index.ts
  - src/worker/llm.ts
  - src/worker/system-prompt.ts
  - src/types/env.d.ts
tags: [backend, api, llm, cloudflare, hono]
---

## Overview

The Cloudflare Worker is the production backend for HyperEdit. Its sole responsibility is generating FFmpeg commands (and explanations) from natural-language user prompts via an LLM. It does **not** execute FFmpeg — execution happens in the local FFmpeg server.

## Key Components

### `src/worker/index.ts` — Hono App

| Function/Route | Line | Description |
|---|---|---|
| `POST /api/ai-edit/start` | async job endpoint | Accepts `{ prompt }`, returns `{ jobId, status: "processing" }`, runs LLM in background via `waitUntil` |
| `GET /api/ai-edit/status/:jobId` | poll endpoint | Returns processing/complete/error status, deletes job on retrieval |
| `POST /api/ai-edit` | legacy sync endpoint | Awaits LLM directly, returns `{ success, command, explanation }` |
| `jobStore` | in-memory Map | Stores job results keyed by UUID, not persisted across cold starts |

### `src/worker/llm.ts` — LLM Abstraction

| Function | Description |
|---|---|
| `generateEditCommand(env, userPrompt)` | Dispatches to Google or OpenAI provider based on `LLM_PROVIDER` env var |
| `parseJSONResponse(text)` | Tries `JSON.parse` first, falls back to regex extraction for dirty output |

Providers:
- **`"google"` (default)**: Uses `@google/genai` with `GEMINI_API_KEY`. Model defaults to `gemini-2.5-flash`.
- **`"openai"`**: Calls any OpenAI-compatible endpoint at `OPENAI_API_BASE_URL`. Model defaults to `qwen3.5:9b`.

Return type: `{ command: string, explanation: string }`

### `src/worker/system-prompt.ts` — Static System Prompt

Instructs LLM to output strict JSON `{ command, explanation }`, always use `input.mp4`/`output.mp4`, always include `-y`. Contains ~15 reference FFmpeg examples.

## Architecture

```text
┌─────────────────┐         ┌──────────────────┐
│  Frontend       │─POST───►│  Hono Worker     │
│  AIPromptPanel  │         │  /api/ai-edit/*  │
└─────────────────┘         └────────┬─────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │  LLM Provider    │
                            │  (Gemini/OpenAI) │
                            └────────┬─────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │  JSON Response   │
                            │  {command, expl} │
                            └──────────────────┘
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes (Google) | — | Google AI API key |
| `LLM_PROVIDER` | No | `"google"` | `"google"` or `"openai"` |
| `LLM_MODEL` | No | Provider default | Override model name |
| `OPENAI_API_BASE_URL` | Yes (OpenAI) | — | Base URL for OpenAI-compatible API |
| `OPENAI_API_KEY` | No | `""` | API key for OpenAI-compatible API |

## Data Flow

1. Frontend sends user prompt to `/api/ai-edit/start`
2. Worker generates UUID job ID, returns immediately
3. Background: system prompt + user prompt sent to LLM
4. LLM response parsed for JSON `{ command, explanation }`
5. Frontend polls `/api/ai-edit/status/:jobId` until complete
6. Frontend receives FFmpeg command string, sends to local FFmpeg server for execution

## Connections

- [[panels]] — AIPromptPanel calls worker API
- [[ffmpeg-server]] — Executes commands worker generates
- [[shared]] — Types shared between worker and frontend

## Known Issues

- Job state is in-memory only (`Map`) — resets on cold start. Intentional for short-lived LLM calls.
- No D1/R2 access in current routes (bindings exist in `wrangler.json` for future use).
- Command strings always reference `input.mp4`/`output.mp4`; FFmpeg server maps these to actual session paths.
