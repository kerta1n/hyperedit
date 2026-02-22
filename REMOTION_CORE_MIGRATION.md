# Remotion Core Migration (HyperEdit)

> Note: This document covers the original Remotion-first migration.
> For the production-focused V2 upgrade (transitions, validation+migrations, campaign scoring), see `REMOTION_CORE_V2.md`.

## Objective

Move HyperEdit from an FFmpeg-command-first compositor to a **Remotion-first deterministic editor core**.

This migration introduces a normalized project spec and routes exports through Remotion by default.

---

## What changed

## 1) Normalized Remotion Project Spec

Added shared schema/types for a spec that represents timeline composition cleanly:

- `tracks`
- `clips`
- `captions`
- `voiceover`
- `brandTheme`
- `adTemplate` (hook/body/cta)
- `transitions`

Files:
- `src/shared/remotion-core.ts`
- `scripts/remotion-core/spec.js`

## 2) Timeline → Spec conversion

Existing session project state is converted to the normalized spec.

File:
- `scripts/remotion-core/timeline-to-spec.js`

Source inputs:
- timeline clips + tracks
- captionData (now persisted in project save/load)
- session assets map

## 3) Remotion-first renderer

Added Remotion composition + renderer pipeline:

- `ProjectTimeline` composition for deterministic timeline rendering
- server-side renderer utility using `@remotion/bundler` + `@remotion/renderer`

Files:
- `src/remotion/ProjectTimeline.tsx`
- `src/remotion/Root.tsx` (new composition id: `ProjectTimeline`)
- `scripts/remotion-core/render.js`

## 4) Server endpoint migration

`POST /session/:id/render` now uses Remotion core.

New endpoints:
- `GET /session/:id/remotion-spec`
- `POST /session/:id/remotion-spec/variants`
- `POST /session/:id/render-from-spec`
- `POST /session/:id/render-variants`
- `POST /session/:id/render-ffmpeg` (legacy fallback compositor)

Main server file updates:
- `scripts/local-ffmpeg-server.js`

## 5) Direct-response ad features

Implemented in spec + generation layer:

- Caption presets:
  - `clean-lower-third`
  - `highlight-mode`
- Hook/body/cta segment template system
- Brand theme object (`fontFamily`, colors, glow, motionSpeed)
- Variant generator (`N` variants with rotated hook/body/cta phrasing)

Files:
- `scripts/remotion-core/spec.js`
- `examples/remotion-specs/cloud-pillow-base.json`

## 6) CLI workflow

Added CLI for spec rendering and variant batch rendering:

- `npm run remotion:render`
- `npm run remotion:variants`
- `npm run remotion:batch`

Files:
- `scripts/remotion-core-cli.js`
- `package.json` scripts

## 7) Caption persistence and UI presets

`captionData` now persists with project save/load so Remotion rendering has access to caption words/styles.

Added quick caption style preset controls in the properties panel:
- Clean Lower Third
- Highlight Mode

Files:
- `src/react-app/hooks/useProject.ts`
- `src/react-app/components/CaptionPropertiesPanel.tsx`

---

## Why this is better than old HyperEdit flow

1. **Deterministic composition model**
   - Timeline state is normalized into a portable JSON spec.
   - Rendering behavior is explicit and reproducible.

2. **Cleaner architecture**
   - Remotion handles visual composition.
   - FFmpeg is retained for preprocessing utilities (trim/dead-air/transcode), not primary assembly.

3. **Better ad iteration speed**
   - Hook/body/cta templating and variant generation are first-class.
   - Caption styling presets + brand theming support direct-response workflows.

4. **Improved dev ergonomics**
   - Render from JSON spec directly.
   - Batch variant rendering from CLI and API.

---

## Notes

- Existing app startup remains intact (`npm run dev` + `npm run ffmpeg-server`).
- Legacy FFmpeg timeline render remains available at `POST /session/:id/render-ffmpeg`.
- Remotion export path is now the default for `/session/:id/render`.
