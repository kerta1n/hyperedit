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
│           │                                         │                            │
│           ▼                                         ▼                            │
│  ┌─────────────────┐                       ┌─────────────────┐                 │
│  │  FFmpeg Server   │                       │  fal.ai         │                 │
│  │  (localhost:3333)│                       │  (DiCaprio/     │                 │
│  │                  │                       │   Picasso)      │                 │
│  │  • Sessions      │                       │                  │                 │
│  │  • Assets        │                       │  • Animate img  │                 │
│  │  • Transcription │                       │  • Restyle vid  │                 │
│  │  • Rendering     │                       │  • Remove bg    │                 │
│  │  • AI animations │                       │  • Generate img │                 │
│  │  • LLM edit cmds │                       │                  │                 │
│  │  • fal.ai proxy  │                       │                  │                 │
│  │  • SPA hosting   │                       │                  │                 │
│  └────────┬─────────┘                       └──────────────────┘                │
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
   Frontend: add to assets[] (clips reach the timeline via drag-and-drop, not automatically)

2. User requests AI edit (Director panel)
   Browser ──POST──► FFmpeg Server /ai-edit
   Server: generateWithLLM (configured provider) with system prompt → {command, explanation}
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
        ├──────────────────┬─────────────────────────────────┤
        ▼                  ▼                                 ▼
┌──────────────┐  ┌──────────────┐                 ┌──────────────┐
│ react-app/   │  │ remotion/    │                 │ scripts/     │
│ hooks/       │  │ templates/   │                 │ remotion-core│
│ components/  │  │ transitions/ │                 │ ffmpeg-server│
│ pages/       │  │ ProjectTL    │                 │              │
└──────┬───────┘  └──────────────┘                 └──────────────┘
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
| [[ffmpeg-server]] | Video processing, sessions, AI, LLM edit commands, SPA hosting | local-ffmpeg-server.js |
| [[shared]] | Types shared across boundaries | remotion-core.ts, ndjson.ts |

## Key Architectural Decisions

1. **No server-side state for timeline** — all timeline state lives in React (useProject). Server only stores assets and project.json snapshot.
2. **Two transition systems coexist** — V1 (junction between clip pairs) and V2 (independent timeline entity). No migration path.
3. **FFmpeg server does everything** — single 7700-line Node.js file handles sessions, assets, transcription, rendering, AI generation, fal.ai proxy.
4. **One backend** — the Cloudflare worker was torn down (2026-07-10); the FFmpeg server generates Director edit commands via the configured LLM provider (`POST /ai-edit`) and serves the built SPA.
5. **Remotion for motion graphics only** — base video editing uses native FFmpeg. Remotion renders overlays, animations, and final composite.
