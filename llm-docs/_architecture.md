---
title: System Architecture
type: architecture
tags: [overview, system-design, data-flow]
---

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              HyperEdit Architecture                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐                │
│  │                    React Frontend (Vite)                      │                │
│  │                                                              │                │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │                │
│  │  │  Asset       │  │  Video       │  │  AI Panels       │  │                │
│  │  │  Library     │  │  Preview     │  │  (Director,      │  │                │
│  │  │              │  │  + Captions  │  │   Picasso,       │  │                │
│  │  └──────┬───────┘  └──────┬───────┘  │   DiCaprio)      │  │                │
│  │         │                  │          └────────┬─────────┘  │                │
│  │         │                  │                   │            │                │
│  │  ┌──────┴──────────────────┴───────────────────┴─────────┐  │                │
│  │  │              Timeline (6 tracks)                        │  │                │
│  │  │  T1 (captions) │ V3 (top) │ V2 (overlay)              │  │                │
│  │  │  V1 (base)     │ A1       │ A2                         │  │                │
│  │  └──────────────────────────┬─────────────────────────────┘  │                │
│  │                             │                                │                │
│  │  ┌──────────────────────────┴─────────────────────────────┐  │                │
│  │  │           useProject() — Central State Hook             │  │                │
│  │  │  assets[], clips[], tracks[], captions[], transitions[] │  │                │
│  │  └──────────────────────────┬─────────────────────────────┘  │                │
│  └─────────────────────────────┼────────────────────────────────┘                │
│                                │                                                 │
│           ┌────────────────────┼────────────────────┐                            │
│           │                    │                    │                            │
│           ▼                    ▼                    ▼                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                 │
│  │  FFmpeg Server   │  │ Cloudflare      │  │  fal.ai         │                 │
│  │  (localhost:3333)│  │ Worker          │  │  (DiCaprio/     │                 │
│  │                  │  │ (Hono + Gemini) │  │   Picasso)      │                 │
│  │  • Sessions      │  │                  │  │                  │                 │
│  │  • Assets        │  │  Generates       │  │  • Animate img  │                 │
│  │  • Transcription │  │  FFmpeg          │  │  • Restyle vid  │                 │
│  │  • Rendering     │  │  commands        │  │  • Remove bg    │                 │
│  │  • AI animations │  │  via LLM         │  │  • Generate img │                 │
│  │  • fal.ai proxy  │  │                  │  │                  │                 │
│  └────────┬─────────┘  └──────────────────┘  └──────────────────┘                │
│           │                                                                      │
│           ▼                                                                      │
│  ┌─────────────────┐                                                            │
│  │  Remotion CLI    │                                                            │
│  │  (render)        │                                                            │
│  │                  │                                                            │
│  │  ProjectTimeline │                                                            │
│  │  DynamicAnimation│                                                            │
│  └──────────────────┘                                                            │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Request/Data Flow

### Typical Editing Session

```text
1. User uploads asset
   Browser ──POST multipart──► FFmpeg Server /session/{id}/assets
   Server: store file, generate thumbnail, return metadata
   Frontend: add to assets[], auto-add clip to timeline

2. User requests AI edit (Director panel)
   Browser ──POST──► Cloudflare Worker /api/ai-edit/start
   Worker: send to Gemini with system prompt → get FFmpeg command
   Browser polls /api/ai-edit/status/:jobId
   Browser ──POST──► FFmpeg Server /session/{id}/process-asset (with command)

3. User adds captions
   Browser ──POST──► FFmpeg Server /session/{id}/transcribe
   Server: run Whisper → return word-level timestamps
   Frontend: chunk words (max 5, 0.7s pause split) → create caption clips on T1

4. User renders final video
   Browser ──POST──► FFmpeg Server /session/{id}/render
   Body: RemotionProjectSpec JSON
   Server: invoke Remotion CLI → stream NDJSON progress
   Browser: readNDJSONStream → update progress bar
```

### AI Animation Generation

```text
Browser ──POST──► FFmpeg Server /session/{id}/generate-animation
  Body: { prompt, contextAssetId?, duration }
  Server:
    1. Send prompt + context frame to Gemini
    2. Gemini returns JSX code for DynamicAnimation scenes
    3. Write temp composition file
    4. Invoke Remotion CLI render
    5. Return rendered .mp4 as new asset
  Frontend: add to assets[], add clip to V2 track
```

## Dependency Graph

```text
┌────────────────┐
│ src/shared/    │◄────────────────────────────────────────────┐
│ (types.ts,     │                                             │
│  remotion-core)│                                             │
└───────┬────────┘                                             │
        │ imports                                              │
        ├──────────────────┬─────────────────┬─────────────────┤
        ▼                  ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ react-app/   │  │ remotion/    │  │ worker/      │  │ scripts/     │
│ hooks/       │  │ templates/   │  │ index.ts     │  │ remotion-core│
│ components/  │  │ transitions/ │  │ llm.ts       │  │ ffmpeg-server│
│ pages/       │  │ ProjectTL    │  │              │  │              │
└──────┬───────┘  └──────────────┘  └──────────────┘  └──────────────┘
       │ imports
       ▼
┌──────────────┐
│ remotion/    │
│ transitions/ │
│ registry     │
└──────────────┘
```

## Module Summary

| Module | Role | Key File(s) |
|--------|------|-------------|
| [[react-app-core]] | State management, main page layout | useProject.ts, Home.tsx |
| [[timeline]] | Multi-track timeline editor | Timeline.tsx, TimelineClip.tsx |
| [[panels]] | AI agents, properties, settings | AIPromptPanel, DiCaprioPanel, etc. |
| [[video-preview]] | Live compositor with captions | VideoPreview.tsx, CaptionRenderer.tsx |
| [[assets-ui]] | Asset library, upload, layout | AssetLibrary.tsx, ResizablePanel.tsx |
| [[remotion-templates]] | Static + dynamic motion graphics | templates/, DynamicAnimation.tsx |
| [[remotion-transitions]] | Pluggable transition components | registry.ts, builtin/, custom/ |
| [[remotion-core]] | Timeline→spec→render pipeline | ProjectTimeline.tsx, render.js |
| [[worker]] | LLM-powered FFmpeg command gen | index.ts, llm.ts |
| [[ffmpeg-server]] | Video processing, sessions, AI | local-ffmpeg-server.js |
| [[shared]] | Types shared across boundaries | remotion-core.ts, ndjson.ts |

## Key Architectural Decisions

1. **No server-side state for timeline** — all timeline state lives in React (useProject). Server only stores assets and project.json snapshot.
2. **Two transition systems coexist** — V1 (junction between clip pairs) and V2 (independent timeline entity). No migration path.
3. **FFmpeg server does everything** — single 7700-line Node.js file handles sessions, assets, transcription, rendering, AI generation, fal.ai proxy.
4. **Worker only generates commands** — never executes FFmpeg. Separation allows local-only development without Cloudflare.
5. **Remotion for motion graphics only** — base video editing uses native FFmpeg. Remotion renders overlays, animations, and final composite.
