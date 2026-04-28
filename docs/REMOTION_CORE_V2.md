# Remotion Core V2 Upgrade Notes

## Scope

This document captures the V2 upgrade completed on top of the Remotion-core branch.

Primary goals:

1. Real transition support in timeline rendering
2. Strict schema validation + migrations (v1 -> v2)
3. First-pass deterministic ad intelligence scoring
4. Campaign-mode batch UX improvements
5. Backward compatibility across existing startup and v1 workflows

---

## 1) Transition Engine Upgrade

### New transition model

V2 introduces **clip junction transitions** on `spec.transitions[]`:

```json
{
  "id": "jx-01",
  "fromClipId": "clip-a",
  "toClipId": "clip-b",
  "type": "crossfade",
  "durationSec": 0.4,
  "easing": "ease-in-out"
}
```

Supported types:

- `crossfade`
- `slide-left`
- `slide-right`
- `dip-to-black`

### Runtime behavior

Implemented in `src/remotion/ProjectTimeline.tsx`:

- Incoming/outgoing clip transition context per clip
- Easing-aware interpolation
- Dip-to-black overlay pass
- Legacy fallback: if `spec.transitions` is missing, legacy clip-level transition fields are derived when possible

### Graceful fallback on invalid overlap constraints

When clips don’t overlap correctly:

- transition is skipped (hard cut fallback), or
- transition duration is clamped to available overlap

No renderer crash on bad overlap geometry.

---

## 2) Strict Spec Validation + Migrations

### Zod-based validation

Implemented in `scripts/remotion-core/spec.js`:

- V2 schema validation (`zod`) for settings/tracks/clips/captions/voiceover/transitions/theme/template
- custom transition reference checks (missing clip IDs / cross-track junctions)

### Versioned migrations

- `migrateSpecToV2(...)` migrates `version: "1.0"` payloads to `"2.0"`
- Legacy `transitionIn` / `transitionOut` are converted to v2 junction transitions when valid
- Migration metadata and warnings are attached in `spec.meta`

### Endpoint and CLI enforcement

- CLI now parses inputs through `parseSpecInput(...)`
- Server render endpoints parse + validate + auto-migrate incoming specs
- Invalid specs return structured `422` payloads with issue details

---

## 3) Ad Intelligence Layer (Deterministic)

Implemented in `scripts/remotion-core/ad-intelligence.js`.

Per-variant heuristic scoring includes:

- segment length fit (hook/body/cta)
- clarity keyword hits
- urgency keyword hits
- benefit keyword hits
- repetition penalties (segment-level + cross-segment)

Batch output artifacts:

- `campaign-intelligence.json`
- `campaign-intelligence.md`

These are produced by:

- CLI `batch` and `campaign` commands
- server `POST /session/:id/render-variants`

---

## 4) Campaign UX Improvements

### Variant controls

`generateAdVariants(...)` now supports:

- hook pool (`hookPool`, legacy `hooks` still accepted)
- body pool (`bodyPool`, legacy `bodies` still accepted)
- CTA pool (`ctaPool`, legacy `ctas` still accepted)
- `toneProfile`
- `captionStyleProfile`

### Campaign mode CLI

New command:

```bash
npm run remotion:campaign -- --spec <spec.json> --out-dir <dir> --count <N>
```

Campaign mode performs:

1. variant generation
2. batch rendering
3. scoring report write-out

---

## 5) Backward Compatibility

Maintained compatibility:

- existing app startup (`npm run dev` + `npm run ffmpeg-server`)
- legacy v1 specs accepted and auto-migrated
- legacy CLI flags (`--hooks`, `--bodies`, `--ctas`) still work
- existing render endpoints preserved

---

## 6) Key Changed Files

- `src/remotion/ProjectTimeline.tsx`
- `src/shared/remotion-core.ts`
- `scripts/remotion-core/spec.js`
- `scripts/remotion-core/ad-intelligence.js` (new)
- `scripts/remotion-core/render.js`
- `scripts/remotion-core-cli.js`
- `scripts/remotion-core/timeline-to-spec.js`
- `scripts/local-ffmpeg-server.js`
- `package.json`
- `README.md`
- `examples/remotion-specs/cloud-pillow-v2-campaign.json` (new)
