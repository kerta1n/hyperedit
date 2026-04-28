---
title: Remotion Templates & Dynamic Animation
type: module
source_files:
  - src/remotion/templates/index.ts
  - src/remotion/templates/AnimatedText.tsx
  - src/remotion/templates/CallToAction.tsx
  - src/remotion/templates/Comparison.tsx
  - src/remotion/templates/Counter.tsx
  - src/remotion/templates/DataChart.tsx
  - src/remotion/templates/LogoReveal.tsx
  - src/remotion/templates/LowerThird.tsx
  - src/remotion/templates/ProgressBar.tsx
  - src/remotion/templates/ScreenFrame.tsx
  - src/remotion/templates/SocialProof.tsx
  - src/remotion/templates/ZoomPan.tsx
  - src/remotion/DynamicAnimation.tsx
  - src/remotion/Root.tsx
  - src/remotion/index.tsx
  - src/remotion/components/Scene3D.tsx
tags:
  - remotion
  - motion-graphics
  - templates
  - animation
  - rendering
---

# Remotion Templates & Dynamic Animation

## Overview

This module is the motion graphics system for HyperEdit. It has two distinct subsystems: eleven pre-built static templates (used in `MotionGraphicsPanel` with `@remotion/player` for live preview), and a `DynamicAnimation` component that renders AI-generated multi-scene animations via the Remotion CLI. The `Root.tsx` file registers two Remotion compositions (`DynamicAnimation` and `ProjectTimeline`) and is the entry point for the Remotion CLI renderer invoked by `scripts/local-ffmpeg-server.js`.

---

## Data Flow

```text
┌─────────────────────────────────────────────────────────────┐
│  Static Template Path (MotionGraphicsPanel → @remotion/player)│
│                                                             │
│  User selects template in UI                                │
│       │                                                     │
│       ▼                                                     │
│  MOTION_TEMPLATES[id].defaultProps ──► template component   │
│       │                                                     │
│       ▼                                                     │
│  @remotion/player renders live preview (no CLI)             │
│       │                                                     │
│       ▼                                                     │
│  POST /session/{id}/render-motion-graphic                   │
│       │  (FFmpeg server runs Remotion CLI)                  │
│       ▼                                                     │
│  Remotion CLI ──► Root.tsx ──► DynamicAnimation or          │
│                               direct template component      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  AI-Generated Dynamic Animation Path                         │
│                                                             │
│  Director agent prompt                                      │
│       │                                                     │
│       ▼                                                     │
│  POST /session/{id}/generate-animation                      │
│  (Gemini writes scenes: Scene[] JSON)                       │
│       │                                                     │
│       ▼                                                     │
│  POST /session/{id}/render-motion-graphic                   │
│  (FFmpeg server passes --props to Remotion CLI)             │
│       │                                                     │
│       ▼                                                     │
│  Root.tsx → Composition id="DynamicAnimation"               │
│       │                                                     │
│       ▼                                                     │
│  DynamicAnimation.tsx                                        │
│  scenes.map() → <Sequence from={offset} duration={n}>       │
│       │                                                     │
│       ▼                                                     │
│  SceneRenderer → scene.type switch                          │
│       │                                                     │
│       ├──► TitleScene / StepsScene / StatsScene / etc.      │
│       ├──► optional CameraWrapper (camera movement)         │
│       └──► optional TransitionWrapper (entry/exit FX)       │
│                                                             │
│  Output: rendered video asset stored in session dir         │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Components

### `src/remotion/templates/index.ts`

#### Constants

| Name | Line | Description |
|------|------|-------------|
| `MOTION_TEMPLATES` | 14 | `as const` registry of all 11 templates keyed by template ID string |
| `TEMPLATE_CATEGORIES` | 179 | `as const` grouping of template IDs by category |

#### Types

| Name | Line | Description |
|------|------|-------------|
| `TemplateId` | 176 | `keyof typeof MOTION_TEMPLATES` — union of all valid template ID strings |

#### `MOTION_TEMPLATES` entries

Each entry has: `name`, `description`, `component` (string name), `category`, `defaultProps`, and a list of valid style/type/effect values.

| Template ID | Category | Component | Styles | Extras |
|-------------|----------|-----------|--------|--------|
| `animated-text` | `text` | `AnimatedText` | `typewriter`, `bounce`, `fade-up`, `word-by-word`, `glitch` | — |
| `lower-third` | `text` | `LowerThird` | `modern`, `minimal`, `bold`, `gradient`, `news` | — |
| `call-to-action` | `engagement` | `CallToAction` | `pill`, `box`, `floating`, `pulse` | `types`: `subscribe`, `like`, `follow`, `share`, `custom` |
| `counter` | `data` | `Counter` | `simple`, `card`, `gradient`, `neon`, `minimal` | — |
| `logo-reveal` | `branding` | `LogoReveal` | `fade`, `scale`, `slide`, `glitch`, `particles` | — |
| `screen-frame` | `mockup` | `ScreenFrame` | `light`, `dark`, `gradient` | `frameTypes`: `browser`, `phone`, `tablet`, `desktop` |
| `social-proof` | `engagement` | `SocialProof` | `card`, `minimal`, `gradient`, `glass` | `types`: `testimonial`, `rating`, `stats`, `logos` |
| `progress-bar` | `data` | `ProgressBar` | `linear`, `circular`, `steps`, `gradient`, `neon` | — |
| `comparison` | `showcase` | `Comparison` | `minimal`, `labeled`, `dramatic` | `types`: `slider`, `side-by-side`, `flip`, `fade` |
| `zoom-pan` | `showcase` | `ZoomPan` | — | `effects`: `zoom-in`, `zoom-out`, `pan-left`, `pan-right`, `pan-up`, `pan-down`, `ken-burns` |
| `data-chart` | `data` | `DataChart` | `minimal`, `gradient`, `neon`, `glass` | `types`: `bar`, `line`, `pie`, `donut` |

#### `TEMPLATE_CATEGORIES` entries

| Category Key | Display Name | Templates |
|---|---|---|
| `text` | Text & Titles | `animated-text`, `lower-third` |
| `engagement` | Engagement | `call-to-action`, `social-proof` |
| `data` | Data & Stats | `counter`, `progress-bar`, `data-chart` |
| `branding` | Branding | `logo-reveal` |
| `mockup` | Mockups | `screen-frame` |
| `showcase` | Showcase | `comparison`, `zoom-pan` |

---

### `src/remotion/templates/AnimatedText.tsx`

#### Interface: `AnimatedTextProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `text` | `string` | required | Text to display |
| `style` | `'typewriter' \| 'bounce' \| 'fade-up' \| 'word-by-word' \| 'glitch'` | `'typewriter'` | Animation style |
| `color` | `string` | `'#ffffff'` | Text color |
| `fontSize` | `number` | `64` | Font size in px |
| `fontFamily` | `string` | `'Inter, system-ui, sans-serif'` | CSS font stack |
| `backgroundColor` | `string` | `'transparent'` | Background color |
| `position` | `'center' \| 'bottom' \| 'top'` | `'center'` | Vertical position |

#### Component: `AnimatedText` (line 13)

Five conditional render branches (all return `<AbsoluteFill>`):

- **`typewriter`** (line 32): Characters revealed over `durationInFrames * 0.7` using `interpolate`. Blinking cursor toggled every `fps/4` frames.
- **`bounce`** (line 56): `spring({ damping: 10, stiffness: 100, mass: 0.5 })` drives `scale`.
- **`fade-up`** (line 80): `interpolate(frame, [0, 20], ...)` for opacity and `translateY`.
- **`word-by-word`** (line 102): Splits on `' '`. Each word has its own `spring` and staggered start at `i * framesPerWord`.
- **`glitch`** (line 150): Two offset layers at `#ff0000` and `#00ffff` shown when `frame % 15 < 3`. Offset driven by `Math.sin(frame * 0.5) * 3`.
- **default** (line 199): Plain text render.

---

### `src/remotion/templates/CallToAction.tsx`

#### Module-level constants (lines 11–25)

- `icons`: maps type string → emoji character
- `labels`: maps type string → display label; `custom` maps to `''`

#### Interface: `CallToActionProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `'subscribe' \| 'like' \| 'follow' \| 'share' \| 'custom'` | required | Button type |
| `customText` | `string` | — | Overrides default label; used when `type === 'custom'` |
| `style` | `'pill' \| 'box' \| 'floating' \| 'pulse'` | `'pill'` | Visual style |
| `primaryColor` | `string` | `'#ef4444'` | Brand color |
| `position` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left' \| 'center'` | `'bottom-right'` | Corner/center placement |

#### Component: `CallToAction` (line 27)

Shared animation setup (lines 50–61):
- `scaleIn`: `spring({ damping: 12, stiffness: 200, mass: 0.8 })`
- `scaleOut`: linear interpolation over last 15 frames
- `scale = scaleIn * scaleOut`

Style branches:
- **`pill`** (line 64): Rounded button, `borderRadius: 50`, horizontal flex.
- **`box`** (line 99): Square card, `bounce = Math.sin(frame * 0.15) * 3` for vertical bob.
- **`floating`** (line 138): Icon-only with `float = Math.sin(frame * 0.1) * 8` bob and animated glow `filter: drop-shadow(0 0 ${20 * glow}px ...)`.
- **`pulse`** (line 178): Pulsating ring overlay using `frame % 30` for ring scale and opacity, plus `Math.sin(frame * 0.2)` for button throb.

---

### `src/remotion/templates/Comparison.tsx`

#### Interface: `ComparisonProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `'slider' \| 'side-by-side' \| 'flip' \| 'fade'` | `'slider'` | Comparison mode |
| `beforeLabel` | `string` | `'Before'` | Label for before state |
| `afterLabel` | `string` | `'After'` | Label for after state |
| `beforeImageUrl` | `string` | — | Optional image for before |
| `afterImageUrl` | `string` | — | Optional image for after |
| `beforeColor` | `string` | `'#ef4444'` | Color fallback for before |
| `afterColor` | `string` | `'#22c55e'` | Color fallback for after |
| `style` | `'minimal' \| 'labeled' \| 'dramatic'` | `'labeled'` | Label overlay style |

#### Component: `Comparison` (line 14)

Style branches:
- **`slider`** (line 30): `clipPath: inset(0 ${100 - sliderPosition}% 0 0)` on the before layer. Position interpolated from 10% to 90% over `durationInFrames * 0.7`. White divider line with circular handle. Labels conditionally rendered when `style === 'labeled'`.
- **`side-by-side`** (line 155): Left and right panels use spring with 15-frame offset for staggered entrance. VS indicator fades in at frames 20–40.
- **`flip`** (line 263): CSS 3D `rotateY` from 0 to 180 deg over frames 30–50. Uses `transformStyle: 'preserve-3d'` and `backfaceVisibility: 'hidden'`.
- **`fade`** (line 332): Cross-dissolve. Label switches text at `fadeProgress < 0.5`.

---

### `src/remotion/templates/Counter.tsx`

#### Interface: `CounterProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `value` | `number` | required | Target count value |
| `prefix` | `string` | `''` | Text before number |
| `suffix` | `string` | `''` | Text after number |
| `label` | `string` | `''` | Caption below number |
| `style` | `'simple' \| 'card' \| 'gradient' \| 'neon' \| 'minimal'` | `'simple'` | Visual style |
| `color` | `string` | `'#f97316'` | Accent color |
| `fontSize` | `number` | `120` | Number font size |
| `position` | `'center' \| 'bottom' \| 'top'` | `'center'` | Vertical position |

#### Component: `Counter` (line 14)

Shared animation (lines 28–43):
- `progress`: spring `{ damping: 50, stiffness: 100, mass: 0.5 }` — drives count
- `displayValue = Math.floor(value * progress)`
- `scale`: spring `{ damping: 12, stiffness: 200 }`
- `opacity`: `interpolate(frame, [0, 15], [0, 1])`

Helper: `formatNumber(num)` (line 52): `num.toLocaleString()`

Style branches:
- **`card`** (line 56): Dark translucent panel with colored glow border.
- **`gradient`** (line 83): `WebkitBackgroundClip: 'text'` gradient using `color` → `#ec4899`.
- **`neon`** (line 110): Black background, layered `textShadow` at 10/20/40/80px.
- **`minimal`** (line 142): `fontWeight: 300`, uppercase spaced label.
- **`simple`** (default, line 167): Colored text with shadow.

---

### `src/remotion/templates/DataChart.tsx`

#### Module-level constant (line 13)

`defaultData`: array of 5 items (Jan–May) with hardcoded values and colors.

#### Interface: `DataChartProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `'bar' \| 'line' \| 'pie' \| 'donut'` | `'bar'` | Chart type |
| `data` | `Array<{ label: string; value: number; color?: string }>` | `defaultData` | Data points |
| `title` | `string` | `''` | Chart title |
| `style` | `'minimal' \| 'gradient' \| 'neon' \| 'glass'` | `'minimal'` | Visual style |
| `color` | `string` | `'#f97316'` | Fallback bar/line color |
| `showValues` | `boolean` | `true` | Show numeric labels |
| `showLabels` | `boolean` | `true` | Show axis labels |

#### Component: `DataChart` (line 21)

Shared: `opacity = interpolate(frame, [0, 20], [0, 1])`, `maxValue = Math.max(...data.map(d => d.value))`

Style branches:
- **`bar`** (line 37): Each bar uses `spring({ frame: Math.max(0, frame - i * 8), ... })` for staggered rise. `neon` style adds `boxShadow`. `gradient` style uses `linear-gradient(to top, ...)`.
- **`line`** (line 110): SVG with 5 grid lines, animated `strokeDashoffset` path, `area fill` fading in, and individual `circle` points each with their own spring delay of `20 + i * 5` frames.
- **`pie` / `donut`** (line 223): Manual arc path calculation from angles using `Math.cos`/`Math.sin`. Donut adds inner radius at `radius * 0.6`. Segments animate with staggered opacity at `10 + i * 5` frames. Legend fades in at `30 + i * 5`. Center text shows `total` for donut.

---

### `src/remotion/templates/LogoReveal.tsx`

#### Interface: `LogoRevealProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `logoUrl` | `string` | — | Optional image URL |
| `logoText` | `string` | `'LOGO'` | Fallback text when no image |
| `tagline` | `string` | `''` | Optional subtitle |
| `style` | `'fade' \| 'scale' \| 'slide' \| 'glitch' \| 'particles'` | `'scale'` | Animation style |
| `color` | `string` | `'#ffffff'` | Text/particle color |
| `backgroundColor` | `string` | `'transparent'` | Background fill |

#### Component: `LogoReveal` (line 12)

Style branches:
- **`fade`** (line 24): `interpolate(frame, [0, 30, durationInFrames - 30, durationInFrames], [0, 1, 1, 0])` — full fade in/out.
- **`scale`** (line 51): Spring `{ damping: 12, stiffness: 100, mass: 0.8 }`. Tagline fades from frame 30–50.
- **`slide`** (line 90): `translateX` from -200 to 0 over 30 frames. Sweep line: a `4px` white bar animating `left` from `-100%` to `110%` over 40 frames, then `opacity: 0`.
- **`glitch`** (line 138): `frame % 20 < 4` triggers. Red/cyan offset layers, `backgroundColor: '#0a0a0a'` forced.
- **`particles`** (line 191): 20 particles at evenly-spaced angles, distance interpolated `[0, 30]` → `[0, 150 + (i % 3) * 50]`. Particles fade out at frame 40–60. Logo uses spring delayed to frame 20.

---

### `src/remotion/templates/LowerThird.tsx`

#### Interface: `LowerThirdProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Primary line (person's name) |
| `title` | `string` | `''` | Secondary line (role/title) |
| `style` | `'modern' \| 'minimal' \| 'bold' \| 'gradient' \| 'news'` | `'modern'` | Visual style |
| `primaryColor` | `string` | `'#f97316'` | Accent/background color |
| `secondaryColor` | `string` | `'#ea580c'` | Secondary gradient color |
| `textColor` | `string` | `'#ffffff'` | Text color |

#### Component: `LowerThird` (line 12)

Shared animation (lines 24–38):
- `slideIn`: spring entry
- `slideOut`: spring on `frame - (durationInFrames - 20)`
- `progress = frame < durationInFrames - 20 ? slideIn : 1 - slideOut`
- `translateX = interpolate(progress, [0, 1], [-400, 0])`
- `opacity = interpolate(progress, [0, 0.3, 0.7, 1], [0, 1, 1, 1])`

Style branches (all positioned `bottom: 80, left: 40` unless noted):
- **`modern`** (line 41): 4px accent bar on left, `name` at 32px bold, `title` in `primaryColor`.
- **`minimal`** (line 87): Name and title inline with `—` separator. Expanding underline: `lineWidth = interpolate(progress, [0.3, 1], [0, 100])`.
- **`bold`** (line 121): Full-width, `bottom: 60, left: 0`. Name block in `primaryColor`, slides up with `translateY`. Title in separate dark block.
- **`gradient`** (line 170): Pill with `linear-gradient(135deg, primaryColor, secondaryColor)`, `borderRadius: 8`.
- **`news`** (line 211): `bottom: 60, left: 0`. 8px red `#dc2626` accent, name in `primaryColor` box, title in `rgba(0,0,0,0.85)` box.

---

### `src/remotion/templates/ProgressBar.tsx`

#### Interface: `ProgressBarProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `progress` | `number` (0–100) | `75` | Target progress percentage |
| `label` | `string` | `''` | Caption text |
| `showPercentage` | `boolean` | `true` | Show numeric % |
| `style` | `'linear' \| 'circular' \| 'steps' \| 'gradient' \| 'neon'` | `'linear'` | Visual style |
| `color` | `string` | `'#f97316'` | Fill color |
| `position` | `'center' \| 'bottom' \| 'top'` | `'center'` | Vertical position |
| `steps` | `number` | `5` | Number of steps (steps style only) |

#### Component: `ProgressBar` (line 13)

Shared: `animatedProgress = interpolate(frame, [0, durationInFrames * 0.6], [0, progress])`, `opacity = interpolate(frame, [0, 15], [0, 1])`

Style branches:
- **`linear`** (line 42): Track `height: 20`, fill width `${animatedProgress}%`.
- **`circular`** (line 82): SVG `radius = (size - strokeWidth) / 2`, `circumference = 2π * radius`, `strokeDashoffset = circumference - (animatedProgress / 100) * circumference`. Circle rotated `-90deg`. Center text positioned `absolute top 50% left 50%`.
- **`steps`** (line 148): `completedSteps = Math.floor((animatedProgress / 100) * steps)`. Each step circle uses spring `Math.max(0, frame - i * 10)`. Connector bar between circles.
- **`gradient`** (line 218): Height 30px, `linear-gradient(90deg, color, #ec4899, #8b5cf6)`.
- **`neon`** (line 257): Height 16px, `boxShadow: 0 0 20px color, 0 0 40px color60`, forced `backgroundColor: '#0a0a0a'`.

---

### `src/remotion/templates/ScreenFrame.tsx`

#### Interface: `ScreenFrameProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `imageUrl` | `string` | — | Screenshot/content image |
| `frameType` | `'browser' \| 'phone' \| 'tablet' \| 'desktop'` | `'browser'` | Device frame type |
| `title` | `string` | `'My App'` | App name (used in phone/tablet/desktop placeholder) |
| `url` | `string` | `'https://example.com'` | URL bar text (browser only) |
| `style` | `'light' \| 'dark' \| 'gradient'` | `'dark'` | Color scheme |
| `animateIn` | `boolean` | `true` | Enable spring entry animation |

#### Component: `ScreenFrame` (line 12)

Shared (lines 23–34):
- `scale = animateIn ? spring(...) : 1`
- `opacity = animateIn ? interpolate(frame, [0, 20], [0, 1]) : 1`
- `bgColor`: `light='#f4f4f5'`, `gradient='#1a1a2e'`, else `'#18181b'`
- `frameColor`: `light='#ffffff'`, else `'#27272a'`
- `textColor`: `light='#18181b'`, else `'#a1a1aa'`
- `dotColors = ['#ff5f57', '#febc2e', '#28c840']` (macOS traffic lights)

Frame branches:
- **`browser`** (line 37): Chrome header with traffic light dots, URL bar, content area `aspectRatio: '16/10'`. `gradient` style applies `linear-gradient(135deg, #1a1a2e, #16213e)` background.
- **`phone`** (line 121): Fixed `width: 320, height: 650`, black chassis, `borderRadius: 40`. Notch: absolute top-center `width: 120, height: 30`.
- **`tablet`** (line 183): `width: 900, height: 600`, `borderRadius: 24`, `padding: 16`.
- **`desktop`** (line 231): Monitor `width: 1000, height: 580` with `borderRadius: '16px 16px 0 0'`. Stand: `width: 200, height: 60`. Base: `width: 300, height: 16`.

---

### `src/remotion/templates/SocialProof.tsx`

#### Interface: `SocialProofProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `'testimonial' \| 'rating' \| 'stats' \| 'logos'` | `'testimonial'` | Content type |
| `quote` | `string` | `'"This product changed everything for us."'` | Testimonial text |
| `author` | `string` | `'Jane Doe'` | Author name |
| `role` | `string` | `'CEO, Company'` | Author role |
| `rating` | `number` | `5` | Star rating (0–5) |
| `stats` | `Array<{ value: string; label: string }>` | 3-item default array | Stats for `stats` type |
| `style` | `'card' \| 'minimal' \| 'gradient' \| 'glass'` | `'card'` | Visual style |
| `color` | `string` | `'#f97316'` | Accent color |

#### Component: `SocialProof` (line 14)

Shared: `scale = spring(...)`, `opacity = interpolate(frame, [0, 20], [0, 1])`

Type branches:
- **`testimonial`** (line 40): `quoteOpacity` frames 10–30, `authorOpacity` frames 30–50. Card style applied as object literal. Leading `"` in `Georgia, serif` at `fontSize: 80, opacity: 0.3`. Quote text strips surrounding quotes with `.replace(/^"|"$/g, '')`.
- **`rating`** (line 106): `starsRevealed = interpolate(frame, [0, 50], [0, rating])`. Each star uses `spring({ frame: Math.max(0, frame - star * 8) })`. Filled stars: `#fbbf24` with glow.
- **`stats`** (line 151): Each stat uses `spring({ frame: Math.max(0, frame - i * 10) })`. Fixed label for review count: `'Based on 10,000+ reviews'` (hardcoded).
- **`logos`** (line 186): Hardcoded array `['Company A', 'Company B', 'Company C', 'Company D', 'Company E']`. Logo names are static placeholder strings — no actual logo images supported.

---

### `src/remotion/templates/ZoomPan.tsx`

#### Interface: `ZoomPanProps` (line 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `imageUrl` | `string` | — | Image to animate |
| `effect` | `'zoom-in' \| 'zoom-out' \| 'pan-left' \| 'pan-right' \| 'pan-up' \| 'pan-down' \| 'ken-burns'` | `'ken-burns'` | Movement type |
| `intensity` | `number` (1–10) | `5` | Effect strength |
| `backgroundColor` | `string` | `'#0a0a0a'` | Background color |
| `overlayText` | `string` | `''` | Optional text overlay |
| `overlayPosition` | `'center' \| 'bottom' \| 'top'` | `'bottom'` | Overlay position |

#### Component: `ZoomPan` (line 12)

Intensity scaling (lines 23–25):
- `zoomAmount = 1 + (intensity / 10) * 0.3` (range 1.03–1.3)
- `panAmount = (intensity / 10) * 15` (range 1.5%–15%)

Transform calculation per effect:
- **`zoom-in`**: `scale: 1 → zoomAmount`
- **`zoom-out`**: `scale: zoomAmount → 1`
- **`pan-left`**: `scale(1.1) translateX(panAmount → -panAmount)`
- **`pan-right`**: `scale(1.1) translateX(-panAmount → panAmount)`
- **`pan-up`**: `scale(1.1) translateY(panAmount → -panAmount)`
- **`pan-down`**: `scale(1.1) translateY(-panAmount → panAmount)`
- **`ken-burns`** (line 64): Combined zoom + pan: `scale(1 → zoomAmount) translate(-panAmount/2 → panAmount/2, -panAmount/3 → panAmount/3)`

Overlay text fades in frames 20–40. Vignette: `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.4) 100%)`. Placeholder shown when no `imageUrl`.

---

## `src/remotion/DynamicAnimation.tsx`

This is the AI-generated animation renderer. All internal components are module-private (not exported) except `DynamicAnimation`, `Scene`, `ShapeConfig`, `EmojiConfig`, `GifConfig`, `LottieConfig`, and `AttachedAsset`.

### Exported Interfaces

#### `ShapeConfig` (line 11)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `'circle' \| 'rect' \| 'triangle' \| 'star' \| 'polygon' \| 'ellipse'` | required | Shape type |
| `fill` | `string` | — | Fill color |
| `stroke` | `string` | — | Stroke color |
| `strokeWidth` | `number` | — | Stroke width |
| `x` | `number` | — | Position % from left (0–100) |
| `y` | `number` | — | Position % from top (0–100) |
| `scale` | `number` | — | Base scale multiplier |
| `rotation` | `number` | — | Degrees rotation |
| `delay` | `number` | — | Animation delay in frames |
| `radius` | `number` | — | circle, polygon radius |
| `width` | `number` | — | rect width |
| `height` | `number` | — | rect height |
| `cornerRadius` | `number` | — | rect, triangle corner radius |
| `length` | `number` | — | triangle side length |
| `direction` | `'up' \| 'down' \| 'left' \| 'right'` | — | triangle direction |
| `points` | `number` | — | star point count, polygon sides |
| `innerRadius` | `number` | — | star inner radius |
| `outerRadius` | `number` | — | star outer radius |
| `rx` | `number` | — | ellipse horizontal radius |
| `ry` | `number` | — | ellipse vertical radius |
| `animation` | `'none' \| 'pop' \| 'spin' \| 'bounce' \| 'float' \| 'pulse' \| 'draw'` | — | Animation mode |

#### `EmojiConfig` (line 39)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `emoji` | `string` | required | Emoji name for `@remotion/animated-emoji` OR literal emoji character |
| `x` | `number` | — | Position % from left |
| `y` | `number` | — | Position % from top |
| `scale` | `number` | `0.15` | Size multiplier (1 = 1024px) |
| `delay` | `number` | — | Animation delay in frames |
| `animation` | `'none' \| 'pop' \| 'bounce' \| 'float' \| 'pulse' \| 'spin' \| 'shake' \| 'wave'` | — | Animation mode |

#### `GifConfig` (line 49)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `src` | `string` | required | GIF URL |
| `x` | `number` | — | Position % |
| `y` | `number` | — | Position % |
| `width` | `number` | — | Width in px |
| `height` | `number` | — | Height in px (auto if unset) |
| `scale` | `number` | — | Size multiplier |
| `delay` | `number` | — | Delay in frames |
| `loop` | `boolean` | `true` | Loop behavior |
| `fit` | `'fill' \| 'contain' \| 'cover'` | — | Fit mode |
| `playbackRate` | `number` | — | Speed multiplier |
| `animation` | `'none' \| 'pop' \| 'bounce' \| 'float' \| 'pulse' \| 'spin' \| 'shake'` | — | Entrance/continuous animation |

#### `LottieConfig` (line 64)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `src` | `string` | required | URL to Lottie JSON |
| `x` | `number` | — | Position % |
| `y` | `number` | — | Position % |
| `width` | `number` | — | Width in px |
| `height` | `number` | — | Height in px |
| `scale` | `number` | — | Size multiplier |
| `delay` | `number` | — | Delay in frames |
| `loop` | `boolean` | — | Loop |
| `playbackRate` | `number` | — | Speed multiplier |
| `direction` | `'forward' \| 'backward'` | — | Playback direction |

#### `Scene` (line 78)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique scene ID |
| `type` | `'title' \| 'steps' \| 'features' \| 'stats' \| 'text' \| 'transition' \| 'media' \| 'chart' \| 'countdown' \| 'comparison' \| 'shapes' \| 'emoji' \| 'gif' \| 'lottie' \| '3d'` | Scene renderer to use |
| `duration` | `number` | Duration in frames |
| `content` | object (see below) | Scene content/config |
| `transition` | `{ type, duration? }` | Optional entry/exit transition |

`Scene.content` fields:

| Field | Type | Description |
|-------|------|-------------|
| `title` | `string` | Main title text |
| `subtitle` | `string` | Secondary text |
| `items` | `Array<{ icon?, label, description?, value?, color? }>` | Steps/features items |
| `stats` | `Array<{ value, label, numericValue?, prefix?, suffix? }>` | Stats with counting animation |
| `color` | `string` | Accent color |
| `backgroundColor` | `string` | Scene background |
| `shapes` | `ShapeConfig[]` | For `shapes` scenes |
| `shapesLayout` | `'scattered' \| 'grid' \| 'circle' \| 'custom'` | Shape layout algorithm |
| `emojis` | `EmojiConfig[]` | For `emoji` scenes |
| `emojiLayout` | `'scattered' \| 'grid' \| 'circle' \| 'row' \| 'custom'` | Emoji layout |
| `gifs` | `GifConfig[]` | For `gif` scenes |
| `gifLayout` | `'scattered' \| 'grid' \| 'circle' \| 'row' \| 'fullscreen' \| 'custom'` | GIF layout |
| `gifBackground` | `string` | URL to background GIF |
| `lotties` | `LottieConfig[]` | For `lottie` scenes |
| `lottieLayout` | `'scattered' \| 'grid' \| 'circle' \| 'row' \| 'fullscreen' \| 'custom'` | Lottie layout |
| `lottieBackground` | `string` | URL to background Lottie JSON |
| `mediaAssetId` | `string` | Asset ID (unused in render; path resolved separately) |
| `mediaPath` | `string` | Absolute file path to media |
| `mediaType` | `'image' \| 'video'` | Media type |
| `mediaStyle` | `'fullscreen' \| 'framed' \| 'pip' \| 'background' \| 'split-left' \| 'split-right' \| 'circle' \| 'phone-frame'` | Display mode |
| `videoStartFrom` | `number` | Start frame for `OffthreadVideo` |
| `videoEndAt` | `number` | End frame for `OffthreadVideo` |
| `videoVolume` | `number` | Volume 0–1 |
| `videoPlaybackRate` | `number` | Speed multiplier |
| `videoLoop` | `boolean` | Loop video |
| `videoMuted` | `boolean` | Mute video |
| `mediaAnimation` | `{ type, intensity? }` | Ken-burns/zoom/pan applied to media itself |
| `additionalMedia` | `Array<{ mediaPath, mediaType, position? }>` | Multi-media montage (field exists in Scene.content; no renderer implemented) |
| `overlayText` | `string` | Text overlay on media |
| `overlayPosition` | `'top' \| 'center' \| 'bottom'` | Overlay position |
| `overlayStyle` | `'minimal' \| 'bold' \| 'gradient-bar'` | Overlay style |
| `chartType` | `'bar' \| 'progress' \| 'pie' \| 'line'` | Chart type (note: `line` type is defined in `scene.content` but NOT handled by `ChartScene` — only `bar`, `pie`, `progress` are rendered) |
| `chartData` | `Array<{ label, value, color? }>` | Chart data |
| `maxValue` | `number` | Chart scale maximum |
| `countFrom` | `number` | Countdown start |
| `countTo` | `number` | Countdown end |
| `beforeLabel` | `string` | Comparison before label |
| `afterLabel` | `string` | Comparison after label |
| `beforeValue` | `string` | Comparison before value text |
| `afterValue` | `string` | Comparison after value text |
| `beforeMedia` | `string` | Path to before media (field defined; not used in `ComparisonScene` renderer) |
| `afterMedia` | `string` | Path to after media (field defined; not used in `ComparisonScene` renderer) |
| `camera` | `{ type, intensity? }` | Camera movement wrapper applied to whole scene |
| `scene3d` | `{ style, text?, secondaryColor?, cameraAnimation?, intensity?, shapes? }` | Config for `3d` scene type |

`Scene.transition.type` values: `'none' \| 'fade' \| 'swipe-left' \| 'swipe-right' \| 'swipe-up' \| 'swipe-down' \| 'zoom-in' \| 'zoom-out' \| 'wipe-left' \| 'wipe-right' \| 'blur' \| 'flip'`

#### `AttachedAsset` (line 184, internal interface)

| Field | Type |
|-------|------|
| `id` | `string` |
| `path` | `string` |
| `type` | `'image' \| 'video'` |
| `filename` | `string` |

#### `DynamicAnimationProps` (line 191)

| Field | Type | Default |
|-------|------|---------|
| `scenes` | `Scene[]` | required |
| `title` | `string` | — |
| `backgroundColor` | `string` | `'#0a0a0a'` |
| `attachedAssets` | `AttachedAsset[]` | — |

Note: `attachedAssets` is declared in the props interface but never consumed inside `DynamicAnimation` — it is not forwarded to any scene renderer.

### Internal Private Components

#### `Particle` (line 199)

Props: `delay`, `angle`, `distance`, `size`, `color`, `duration`. Uses spring to drive `x/y` position and opacity/scale interpolation. `duration` prop is received but NOT used in the component body.

#### `ExplosionEffect` (line 238)

Props: `color` (default `'#f97316'`), `particleCount` (default 12), `delay` (default 0). Uses `useMemo` to generate deterministic particle configs (BUT uses `Math.random()` inside, so particle sizes/distances are non-deterministic between renders).

#### `GradientBackground` (line 270)

Props: `color1` (default `'#0a0a0a'`), `color2` (default `'#1a1a2e'`), `color3` (default `'#16213e'`). Infinite rotating conic gradient via `interpolate(frame, [0, 300], [0, 360], { extrapolateRight: 'extend' })`.

#### `GlowingOrb` (line 292)

Props: `x`, `y`, `size`, `color`, `delay` (default 0). Pulsing scale via `Math.sin(frame * 0.1)`.

#### `AnimatedText` (line 329, internal — different from the exported template)

Props: `text`, `fontSize`, `color`, `delay` (default 0), `style` (`'typewriter' \| 'bounce' \| 'wave' \| 'glitch'`, default `'bounce'`), `fontWeight` (default `'bold'`). Character-by-character with stagger. Stagger is proportional to scene duration: `maxStaggerTime = Math.min(durationInFrames * 0.3, 40)`, `charStagger = Math.min(2, maxStaggerTime / characters.length)`. Glitch variant uses `Math.random()` for non-deterministic character jitter.

#### `AnimatedNumber` (line 406)

Props: `value`, `prefix`, `suffix`, `fontSize` (default 108), `color`, `delay` (default 0), `duration` (default 60). Counts from 0 to `value` using eased interpolation (cubic ease-out: `1 - Math.pow(1 - progress, 3)`). Includes debug `console.log` on frames 0–3. Pulsing glow: `glowPulse = Math.sin((frame - delay) * 0.08) * 10 + 30`.

#### `CameraWrapper` (line 461)

Props: `children`, `type` (all camera types + `'none'`), `intensity` (default 0.3). Wraps children with overflow-hidden container. Camera types:
- `zoom-in / zoom-out`: spring-smoothed scale
- `pan-left / pan-right / pan-up / pan-down`: linear translate
- `ken-burns`: spring scale + linear translate
- `shake`: dual-frequency sine waves for organic movement + rotation

#### `TransitionWrapper` (line 531)

Props: `children`, `transitionType`, `transitionDuration` (default 15). Note: the interface has `transitionDuration` declared **twice** (line 534–535) — a TypeScript error that is silently tolerated by the compiler because the second declaration is identical.

Transition types implemented:
- `fade`: opacity only
- `swipe-left / swipe-right / swipe-up / swipe-down`: full-width/height translate using eased spring
- `zoom-in / zoom-out`: scale + opacity
- `wipe-left / wipe-right`: `clipPath: inset(...)` reveal
- `blur`: `filter: blur(${n}px)` + opacity
- `flip`: `perspective(1000px) rotateY(deg)` with opacity gating

#### `ProgressBar` (line 710, internal — different from the exported template)

Props: `value`, `maxValue`, `label`, `color` (default `'#f97316'`), `delay` (default 0). Used only by `ChartScene` for `chartType: 'progress'`.

#### `BarChart` (line 755)

Props: `data`, `maxValue?`, `delay` (default 0). Each bar springs up with `delay + index * 8`. Bar height = `(item.value / actualMax) * 250`. Fallback color palette: `['#f97316', '#3b82f6', '#22c55e', '#8b5cf6', '#ec4899', '#eab308']`.

#### `PieChart` (line 820)

Props: `data`, `size` (default 300), `delay` (default 0). Uses `conic-gradient` CSS rather than SVG paths. Progress drives sweep via `spring`. Legend with color swatches.

#### `SceneTransition` (line 886)

Props: `type` (`'fade' \| 'zoom' \| 'swipe' \| 'burst'`), `color` (default `'#f97316'`), `entering` (default `true`). Only `burst` type is implemented — expands/contracts a circle. Returns `null` for all other types.

#### `TitleScene` (line 926)

Renders: `GradientBackground`, two `GlowingOrb`s, `ExplosionEffect` for first 30 frames, main `AnimatedText` with `bounce` style, optional subtitle `AnimatedText` with `wave` style, animated underline accent bar (width `0 → 300` over frames 15–35), trailing `SceneTransition type="burst"`.

#### `StepsScene` (line 1026)

Renders up to ~4 items (layout assumes wide horizontal). Per-item stagger uses `durationInFrames` proportion for short scenes. Each item: spring entry with scale/opacity/rotate, icon container with pulse `Math.sin((frame - delay) * 0.1) * 0.05 + 1`.

#### `extractNumericFromString` (line 1168)

Function (not a component). Parses `"10K+"` → `{ numericValue: 10000, prefix: '', suffix: '+' }`. Handles `k/K/thousand`, `m/M/million`, `b/B/billion` multipliers and currency prefix characters `£$€¥₹#@~`.

#### `StatsScene` (line 1210)

Includes `console.log` statements on every frame via `processedStats` useMemo (lines 1220, 1222, 1226, 1237, 1243, 1251, 1256) — **these fire on every re-render during preview**. Stats with `numericValue` use `AnimatedNumber`; others show static text. Entry: scale from 0 to 1 + `rotateY(180deg → 0deg)`.

#### `TextScene` (line 1373)

Single `AnimatedText` with `wave` style, `fontWeight: 600`. Two `GlowingOrb`s.

#### `TransitionScene` (line 1416)

Three expanding rings with offsets 0/10/20 frames. Each ring: scale 0→30, opacity 0.8→0.5→0.

#### `MediaAnimationWrapper` (line 1465)

Props: `children`, `animationType`, `intensity` (default 0.3). Applies to the media element itself (inside `MediaScene`). Types: `ken-burns`, `zoom-in`, `zoom-out`, `pan-left`, `pan-right`, `pan-up`, `pan-down`, `rotate`, `parallax`.

#### `PhoneFrame` (line 1531)

Props: `children`. Fixed `375 × 812px` container with notch (`width: 150, height: 30`).

#### `MediaTextOverlay` (line 1567)

Props: `text`, `position` (default `'bottom'`), `style` (default `'minimal'`), `color` (default `'#ffffff'`). Helper `getTextStyles()` switches between `bold`/`gradient-bar`/`minimal` styles.

#### `MediaScene` (line 1641)

Calls `preloadVideo`/`preloadImage` in `useEffect` on mount. `getStylesForMode()` returns container/media styles for each `mediaStyle`. For `phone-frame`, sets `usePhoneFrame: true` on return object, which is read back via cast `(styles as { usePhoneFrame?: boolean }).usePhoneFrame`. Logs state to `console.log` on frames 0–1.

Media modes and their container shapes:
- `fullscreen`: 100% × 100%, no decorations
- `background`: 100% × 100%, `filter: brightness(0.5)`, no decorations
- `pip`: absolute bottom-right 35% width
- `split-left`: absolute left 0 top 0, 50% width
- `split-right`: absolute right 0 top 0, 50% width
- `circle`: 500 × 500px circular
- `phone-frame`: wrapped in `PhoneFrame`
- `framed` (default): max 80% × 70%, rounded 20px

#### `ChartScene` (line 1995)

Delegates to `BarChart`, `PieChart`, or internal `ProgressBar`. Note: `chartType: 'line'` is defined in `SceneContent` but NOT dispatched here — it falls through with no output.

#### `ComparisonScene` (line 2081)

Renders two boxes (before/after) with spring slide-in from ±100px. `beforeMedia` and `afterMedia` are defined in `Scene.content` but NOT rendered here.

#### `CountdownScene` (line 2190)

`countFrom` default 3, `countTo` default 0. Frames evenly divided: `framesPerCount = Math.floor(durationInFrames / totalCount)`. Within each count: spring scale 0.5→1.2→1, fade opacity at start/end.

#### `AnimatedShape` (line 2258, 2D shapes)

Props: `shape: ShapeConfig`, `index`. Dispatches `@remotion/shapes` primitives. Animation modes: `pop`, `spin`, `bounce`, `float`, `pulse`, `draw`. `draw` mode does not actually implement stroke-dasharray animation despite the comment — it only applies scale/opacity entry.

#### `ShapesScene` (line 2399)

Layout algorithms for `scattered` (deterministic: `20 + (index * 37) % 60`), `grid` (sqrt-based cols), `circle` (evenly spaced angles at 30% radius). Default shapes shown when `shapes` prop is empty.

#### `AnimatedEmojiItem` (line 2511)

Uses `@remotion/animated-emoji`'s `AnimatedEmoji` for named emojis. Falls back to a raw DOM emoji character when `isEmojiCharacter` is true (`emoji.length <= 4 && /\p{Emoji}/u.test(emoji)`). The `useState(true)` for `useAnimatedEmoji` has no setter called — it is always `true`.

#### `EmojiScene` (line 2626)

Layout: `scattered`, `grid`, `circle`, `row`. Default emojis: `🔥`, `⭐`, `🚀`.

#### `AnimatedGifItem` (line 2743)

Renders `@remotion/gif`'s `<Gif>`. Animation styles applied as additional `animationStyle` spread — NOTE: the `animationStyle` transform overrides the `entranceProgress`-based scale in the outer `transform` property when both are set, because both are on the same element via spread.

#### `GifScene` (line 2842)

Supports background GIF with 0.4 opacity + dark overlay. `fullscreen` layout renders the first GIF only via `<Gif>` directly.

#### `LottieItem` (line 2999)

Fetches Lottie JSON from `src` URL on mount. Uses `delayRender`/`continueRender` to pause rendering until JSON is loaded. Always calls `continueRender` in catch block. Background-level `LottieScene` does NOT use `delayRender`/`continueRender` for its background Lottie fetch (potential race condition on fast renders).

#### `LottieScene` (line 3069)

Background Lottie `bgAnimationData` fetched in `useEffect` without `delayRender` — if the render starts before the fetch resolves, the background Lottie is skipped silently.

#### `SceneRenderer` (line 3225)

Switch dispatch from `scene.type` to scene components. `features` maps to `StepsScene`. `3d` maps to `Scene3D`. Unknown type falls through to `TitleScene`. Applies `CameraWrapper` if `scene.content.camera?.type` is set, then `TransitionWrapper` if `scene.transition?.type` is set and not `'none'`.

#### `DynamicAnimation` (line 3302, exported)

Maps `scenes` array to `<Sequence from={offset} durationInFrames={scene.duration}>` using a running `frameOffset` accumulator. Does not validate that total frames match video duration — the Remotion composition duration is calculated separately in `Root.tsx`.

---

## `src/remotion/components/Scene3D.tsx`

### Exported Interfaces

#### `Scene3DConfig` (line 9)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `style` | `'3d-text' \| '3d-logo' \| '3d-product' \| '3d-particles' \| '3d-shapes' \| '3d-showcase'` | required | 3D scene style |
| `text` | `string` | `'3D'` | Text for `3d-text` / `3d-logo` |
| `subtitle` | `string` | — | Not rendered (field declared, unused) |
| `color` | `string` | `'#f97316'` | Primary color |
| `backgroundColor` | `string` | `'#0a0a0a'` | Canvas background |
| `secondaryColor` | `string` | `'#3b82f6'` | Secondary accent |
| `cameraAnimation` | `'orbit' \| 'zoom-in' \| 'zoom-out' \| 'pan' \| 'static'` | `'orbit'` | Camera movement |
| `intensity` | `number` | — | Unused (passed through from `Scene.content.scene3d.intensity` but not consumed in `Scene3D`) |
| `shapes` | `Array<{ type, color?, position?, scale?, animation? }>` | — | 3D shapes for shapes/showcase styles |

### Private Components

#### `AnimatedText3D` (line 28)

Uses `@react-three/drei`'s `<Text>` with Inter font loaded from Google Fonts CDN: `https://fonts.gstatic.com/s/inter/v13/...woff2`. Rotation: `interpolate(frame, [0, durationInFrames], [0, Math.PI * 0.3])` applied via `useFrame`. Shadow text at `[0.05, -0.05, -0.1]` with `opacity: 0.3`.

#### `AnimatedShape` (line 79, 3D shapes — different from 2D AnimatedShape)

Props: `type`, `color`, `position`, `scale`, `animation`, `index`. Geometry mapped via `useMemo`. Spring-based entry `frame - index * 5`. `useFrame` callback applies rotation and per-animation mutations. `pulse` animation short-circuits with `return` to skip default scale apply (line 116).

Geometry mappings:
- `sphere`: `sphereGeometry args={[0.5, 32, 32]}`
- `torus`: `torusGeometry args={[0.4, 0.15, 16, 32]}`
- `cylinder`: `cylinderGeometry args={[0.3, 0.3, 0.8, 32]}`
- `cone`: `coneGeometry args={[0.4, 0.8, 32]}`
- `dodecahedron`: `dodecahedronGeometry args={[0.5]}`
- `octahedron`: `octahedronGeometry args={[0.5]}`
- `cube` (default): `boxGeometry args={[0.7, 0.7, 0.7]}`

Material: `meshStandardMaterial` with `metalness: 0.6, roughness: 0.3, emissive: color, emissiveIntensity: 0.1`.

#### `ParticleField` (line 160)

Props: `count`, `color`. Positions generated with `Math.random()` in `useMemo` — non-deterministic per render. Whole system rotates `frame * 0.001` on Y, `frame * 0.0005` on X via `useFrame`.

#### `ProductShowcase` (line 197)

Continuous Y rotation `interpolate(frame, [0, durationInFrames], [0, Math.PI * 2])` via `useFrame`. Platform: `cylinderGeometry args={[2, 2, 0.1, 64]}`. Product: `RoundedBox` from drei at `[0, 0.2, 0]`. Two floating accent shapes use drei `<Float>`.

#### `Scene3DContent` (line 245)

Switch-style style dispatch. `3d-text` and `3d-logo` both show `AnimatedText3D`. `3d-shapes` and `3d-particles` both show `AnimatedShape` array. `3d-product` shows `ProductShowcase`. `3d-showcase` shows `ProductShowcase` + scaled `AnimatedShape` array. Default shapes used when `shapes` is empty and style is `3d-shapes`.

Lighting setup: `ambientLight intensity={0.4}`, `directionalLight [5,5,5] intensity={1}`, two `pointLight`s in complementary colors.

#### `Scene3D` (line 322, exported)

Camera position computed from `cameraAnimation`:
- `orbit`: `cameraX = Math.sin(orbitAngle) * 5`, `cameraZ = Math.cos(orbitAngle) * 5`
- `zoom-in`: `cameraZ = interpolate(frame, [0, durationInFrames], [8, 4])`
- `zoom-out`: `cameraZ = interpolate(frame, [0, durationInFrames], [4, 8])`
- `pan` and `static`: both use fixed `cameraZ = 5`, `cameraX = 0` (pan is not actually implemented — it behaves the same as static)

Wraps in `ThreeCanvas width={width} height={height} camera={{ position: [cameraX, 2, cameraZ], fov: 50 }} gl={{ antialias: true }}`.

---

## `src/remotion/Root.tsx`

### Exported Types

| Name | Line | Description |
|------|------|-------------|
| `DynamicAnimationProps` | 9 | Props for CLI rendering: `scenes`, `title?`, `backgroundColor?`, `totalDuration?` |
| `ShapeConfig` | 16 | Re-declared (mirrors `DynamicAnimation.tsx` interface) |
| `EmojiConfig` | 40 | Re-declared |
| `GifConfig` | 49 | Re-declared |
| `LottieConfig` | 63 | Re-declared |
| `Scene` | 76 | Re-declared with slight differences (no `'3d'` in type union — see Known Issues) |
| `SceneContent` | 87 | Inline content type (in `Root.tsx` instead of `DynamicAnimation.tsx`) |

Note: `Root.tsx` declares its own `Scene` interface (line 76) whose `type` union does NOT include `'3d'`. `DynamicAnimation.tsx` has `'3d'` in its own `Scene.type` union (line 80). These are duplicate, diverged interfaces.

### Functions

#### `calculateDuration(props: DynamicAnimationProps): number` (line 167)

Returns `props.totalDuration` if set, else sums `scene.duration` for all scenes, else `300`.

#### `calculateProjectDuration(spec: RemotionProjectSpec): number` (line 221)

Finds the maximum end time across `spec.clips`, `spec.captions`, and `spec.voiceover`, converts to frames using `spec.settings.fps`. Minimum duration: 1 frame. Ensures at least 2 seconds of content.

#### `RemotionRoot` (line 241)

Registers two Remotion `<Composition>` elements:
1. `id="DynamicAnimation"`: component `DynamicAnimation`, default 300 frames at 30fps, 1920×1080. `calculateMetadata` calls `calculateDuration`.
2. `id="ProjectTimeline"`: component `ProjectTimeline`, default 300 frames at 30fps. `calculateMetadata` calls `calculateProjectDuration` and also overrides `width`, `height`, `fps` from the spec.

Also imports: `./transitions/init` (line 6) to register custom transitions.

### `defaultProjectSpec` (line 177)

Hardcoded `RemotionProjectSpec` used when no spec prop is provided to `ProjectTimeline`. Has 6 tracks (T1, V3, V2, V1, A1, A2), empty clips/captions/voiceover, orange/blue brand theme, and a `hook-body-cta` ad template structure.

---

## `src/remotion/index.tsx`

Entry point for the Remotion CLI renderer.

| Export | Source | Description |
|--------|--------|-------------|
| `registerRoot(RemotionRoot)` | line 3 | Registers the root component with Remotion CLI |
| `RemotionRoot` | `./Root` | Re-exported |
| `DynamicAnimation` | `./DynamicAnimation` | Re-exported |
| `ProjectTimeline` | `./ProjectTimeline` | Re-exported |
| `Scene` | `./Root` | Type re-exported |
| `DynamicAnimationProps` | `./Root` | Type re-exported |
| `RemotionProjectSpec` | `../shared/remotion-core` | Type re-exported |
| `CustomTransitionProps` | `./transitions/types` | Type re-exported |

---

## Connections

- [[motion-graphics-panel]] — `MotionGraphicsPanel` consumes `MOTION_TEMPLATES`, `TEMPLATE_CATEGORIES`, and `TemplateId` from `templates/index.ts`. It uses `@remotion/player` with each template component for live preview.
- [[use-project]] — `useProject` hook triggers `POST /session/{id}/render-motion-graphic` which invokes Remotion CLI with `--props`.
- [[local-ffmpeg-server]] — `scripts/local-ffmpeg-server.js` calls `remotion render DynamicAnimation` or template renders using this module as the composition source.
- [[director-panel]] — Director AI agent (`AIPromptPanel`) generates `scenes: Scene[]` JSON passed to the FFmpeg server, which renders via `DynamicAnimation`.
- [[remotion-core]] — `src/shared/remotion-core.ts` defines `RemotionProjectSpec` consumed by `Root.tsx` for `ProjectTimeline`.
- [[project-timeline-remotion]] — `ProjectTimeline` component registered alongside `DynamicAnimation` in `Root.tsx`.

---

## Known Issues

### Duplicate / Diverged `Scene` Interface

`DynamicAnimation.tsx` (line 80) includes `'3d'` in `Scene.type`. `Root.tsx` (line 76) re-declares `Scene` without `'3d'`. The `index.tsx` exports `Scene` from `Root.tsx`, so callers importing `Scene` from the package do not see the `'3d'` type. The internal `SceneRenderer` still handles `'3d'` correctly because it imports directly from `DynamicAnimation.tsx`.

### `TransitionWrapper` Duplicate Parameter

`TransitionWrapper` interface (lines 534–535 in `DynamicAnimation.tsx`) declares `transitionDuration` twice. TypeScript accepts this silently.

### `additionalMedia` Not Rendered

`Scene.content.additionalMedia` is defined in the interface but no scene renderer handles it. A montage/collage layout is documented in the field comment but is dead code.

### `chartType: 'line'` Not Handled in ChartScene

`ChartScene` (line 2037) only dispatches `bar`, `pie`, and `progress`. `line` falls through with no render output. `DataChart` template (standalone) does render line charts, but `DynamicAnimation`'s `ChartScene` does not.

### `beforeMedia` / `afterMedia` Not Rendered

`ComparisonScene` (line 2081) shows text values only. The `beforeMedia` and `afterMedia` fields in `Scene.content` are never read by `ComparisonScene`.

### Non-Deterministic Randomness in Remotion

`ExplosionEffect` (line 248), `ParticleField` (line 164), and `AnimatedText`'s glitch style use `Math.random()` at render time. Remotion requires deterministic rendering (the same frame should produce the same output on every render pass). These components will produce different visuals on each render.

### `console.log` in `StatsScene`

`StatsScene` contains multiple `console.log` calls inside a `useMemo` that runs every render and on every prop change (lines 1220, 1222–1256). During `@remotion/player` preview at 30fps this generates continuous console noise.

### `LottieScene` Background Fetch Without `delayRender`

`LottieScene` (line 3078) fetches `backgroundLottie` in a `useEffect` without calling `delayRender`. If the CLI renderer reaches that frame before the fetch resolves, the background Lottie is silently omitted. `LottieItem` correctly uses `delayRender`/`continueRender`.

### `cameraAnimation: 'pan'` is a No-Op

`Scene3D` (line 331–334) does not implement `'pan'`. When `cameraAnimation === 'pan'`, `cameraX = 0` and `cameraZ = 5` — identical to `'static'`.

### `Scene3DConfig.subtitle` Unused

`subtitle` is declared in `Scene3DConfig` (line 11) but never rendered by any component in `Scene3D.tsx`.

### `Scene3DConfig.intensity` Unused

`intensity` is declared in `Scene3DConfig` (line 16) and passed through from the scene dispatch in `SceneRenderer` (line 3265), but `Scene3D.tsx` never reads it.

### `DynamicAnimationProps.attachedAssets` Unused

`attachedAssets` is declared in the `DynamicAnimationProps` interface (line 195) but never consumed inside `DynamicAnimation` (line 3302). It was presumably intended to provide path resolution for `mediaPath` fields.

### `AnimatedGifItem` `animationStyle` Transform Conflict

When `AnimatedGifItem` has both an entrance scale (`transform: translate(-50%,-50%) scale(...)`) on the outer `div` AND a continuous `animationStyle` with its own `transform`, the spread at line 2822 overwrites the outer div's `transform`. Result: entrance scaling is invisible when an animation mode is active.

### `SocialProof` `logos` Type Has Hardcoded Names

`SocialProof` with `type === 'logos'` (line 187) always renders `['Company A', 'Company B', 'Company C', 'Company D', 'Company E']` regardless of any props. There is no field in `SocialProofProps` to pass real logo names or images.

### `AnimatedEmojiItem` `useState` Setter Never Called

`const [useAnimatedEmoji] = useState(true)` (line 2517) — the setter is destructured away (array element 1 is unused). `useAnimatedEmoji` is always `true`. The conditional at line 2613 can only reach the `AnimatedEmoji` branch (when the emoji is a named emoji) or the fallback (when it's a literal character).
