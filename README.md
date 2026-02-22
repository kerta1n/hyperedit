## HyperEdit (Remotion Core V2)

HyperEdit now runs on a deterministic **Remotion-first** rendering core with a production-focused V2 upgrade:

- **Real timeline transitions**: `crossfade`, `slide-left`, `slide-right`, `dip-to-black`
- **Strict spec validation + migrations** (v1 → v2) with clear validation errors
- **Ad intelligence scoring** for hook/body/cta quality on render batches
- **Campaign mode UX** for generating and rendering N variants + score reports in one command
- Backward compatibility for existing v1 endpoints/CLI inputs

---

## Quickstart

```bash
npm install --legacy-peer-deps
npm run cf-typegen   # needed once on clean checkout for worker types
npm run dev
npm run ffmpeg-server
```

Open the app, upload assets, edit timeline, then export.

---

## V2 Feature Highlights

### 1) Transition engine upgrade

V2 adds junction-based transitions (per clip-to-clip handoff):

- `crossfade`
- `slide-left` / `slide-right` (translate/mask-style)
- `dip-to-black`
- Per-transition params: `durationSec`, `easing`

If overlap constraints are invalid, transitions gracefully fall back (clamped or skipped) instead of crashing renders.

### 2) Strict spec validation + migrations

- Zod validation for Remotion spec input
- Versioned migration path from `1.0` to `2.0`
- Render endpoints and CLI auto-migrate v1 payloads
- Invalid payloads return structured error details (`422 INVALID_REMOTION_SPEC`)

### 3) Ad intelligence layer (deterministic)

Batch render workflows now emit scoring reports for copy quality:

- length fit per segment (hook/body/cta)
- clarity keywords
- urgency + benefit language
- repetition penalties

Reports are saved as:

- `campaign-intelligence.json`
- `campaign-intelligence.md`

### 4) Campaign mode controls

Variant generation now supports:

- `hook pool` / `body pool` / `cta pool`
- `tone profile`
- `caption style profile`

---

## Remotion-first API

### Core project + render

- `GET /session/:id/project`
- `PUT /session/:id/project`
- `GET /session/:id/remotion-spec` → build normalized Remotion spec
- `POST /session/:id/render` → render via Remotion core
- `POST /session/:id/render-from-spec` → render explicit spec JSON
- `POST /session/:id/render-variants` → generate + render variant batch (+ score report)
- `POST /session/:id/render-ffmpeg` → legacy FFmpeg compositor path

### Variant + ad tooling

- `POST /session/:id/remotion-spec/variants`
  - Generates hook/body/cta variants
  - Supports pool + profile controls

---

## CLI / Dev Workflow

Render one spec:

```bash
npm run remotion:render -- \
  --spec examples/remotion-specs/cloud-pillow-v2-campaign.json \
  --out tmp/cloud-pillow-v2.mp4
```

Generate variant specs only:

```bash
npm run remotion:variants -- \
  --spec examples/remotion-specs/cloud-pillow-v2-campaign.json \
  --out-dir tmp/cloud-pillow-variants \
  --count 4 \
  --hook-pool "Stop scrolling,Neck pain in the morning?" \
  --cta-pool "Tap now,Shop today" \
  --tone-profile direct-response \
  --caption-style-profile punchy
```

Generate + render batch (+ intelligence report):

```bash
npm run remotion:batch -- \
  --spec examples/remotion-specs/cloud-pillow-v2-campaign.json \
  --out-dir tmp/cloud-pillow-batch \
  --count 4 \
  --preview
```

### Campaign mode (new)

One-command campaign generation, rendering, and scoring:

```bash
npm run remotion:campaign -- \
  --spec examples/remotion-specs/cloud-pillow-v2-campaign.json \
  --out-dir tmp/cloud-pillow-campaign \
  --count 6 \
  --hook-pool "If you're waking up sore,Neck pain in the morning?" \
  --cta-pool "Tap to claim 30% off,Shop now" \
  --tone-profile direct-response \
  --caption-style-profile punchy \
  --preview
```

---

## Migration Notes (v1 → v2)

- Existing v1 specs (`version: "1.0"`) are auto-migrated to v2 on render/variant endpoints and CLI.
- Legacy clip transitions (`transitionIn` / `transitionOut`) are converted to v2 clip-junction transitions when possible.
- Invalid transition overlaps are safely clamped/skipped and recorded as warnings.
- Existing startup flow remains the same (`npm run dev` + `npm run ffmpeg-server`).

For deeper migration details, see:

- `REMOTION_CORE_MIGRATION.md`
- `REMOTION_CORE_V2.md`

---

## Example specs

- `examples/remotion-specs/cloud-pillow-base.json` (v1-compatible input)
- `examples/remotion-specs/cloud-pillow-v2-campaign.json` (v2 campaign-ready input)
- `examples/remotion-specs/cloud-pillow-variant-brief.json`
