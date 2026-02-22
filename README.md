## HyperEdit (Remotion-First Core)

HyperEdit is now built around a deterministic **Remotion-first** editor core.

- Timeline state is normalized into a render spec (`clips`, `tracks`, `captions`, `style`, `voiceover`, `transitions`)
- Export rendering runs through Remotion by default (`POST /session/:id/render`)
- FFmpeg remains available as optional utility tooling (`trim`, `dead-air`, transcode, and legacy render endpoint)

---

## Quickstart

```bash
npm install --legacy-peer-deps
npm run cf-typegen   # needed once on clean checkout for worker types
npm run dev
npm run ffmpeg-server
```

Open the app, upload assets, edit timeline, then export.

The export endpoint now uses Remotion as the primary composition engine.

---

## Remotion-first API

### Core project + render
- `GET /session/:id/project`
- `PUT /session/:id/project`
- `GET /session/:id/remotion-spec` → build normalized Remotion spec from timeline
- `POST /session/:id/render` → render via Remotion core (preview/export)
- `POST /session/:id/render-from-spec` → render from explicit spec JSON
- `POST /session/:id/render-variants` → batch render ad variants
- `POST /session/:id/render-ffmpeg` → legacy FFmpeg compositor path

### Variant + ad tooling
- `POST /session/:id/remotion-spec/variants`
  - Generates `N` hook/body/cta variants
  - Applies caption preset strategy (`clean-lower-third` + `highlight-mode`)

---

## CLI / Dev Workflow

Render one JSON spec:

```bash
npm run remotion:render -- \
  --spec examples/remotion-specs/cloud-pillow-base.json \
  --out tmp/cloud-pillow.mp4
```

Generate variant specs only:

```bash
npm run remotion:variants -- \
  --spec examples/remotion-specs/cloud-pillow-base.json \
  --out-dir tmp/cloud-pillow-variants \
  --count 4
```

Generate + render variant batch:

```bash
npm run remotion:batch -- \
  --spec examples/remotion-specs/cloud-pillow-base.json \
  --out-dir tmp/cloud-pillow-variants \
  --count 4
```

Sample Cloud Pillow assets/specs:
- `examples/remotion-specs/cloud-pillow-base.json`
- `examples/remotion-specs/cloud-pillow-variant-brief.json`

---

## Why this is better than old HyperEdit flow

1. **Deterministic rendering**
   - Timeline → normalized spec → render output.
   - No fragile FFmpeg filter graph stitching as the primary editor engine.

2. **Ad-native workflows**
   - Hook/body/cta segment templateing, brand theme object, and variant generation built into the core model.

3. **Composable architecture**
   - FFmpeg is still useful, but now treated as optional pre/post processing utilities rather than the main compositor.

---

Need migration details? See `REMOTION_CORE_MIGRATION.md`.
