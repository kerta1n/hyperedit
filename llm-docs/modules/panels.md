---
title: "Panels"
type: module
source_files:
  - src/react-app/components/AIPromptPanel.tsx
  - src/react-app/components/DiCaprioPanel.tsx
  - src/react-app/components/PicassoPanel.tsx
  - src/react-app/components/MotionGraphicsPanel.tsx
  - src/react-app/components/ClipPropertiesPanel.tsx
  - src/react-app/components/CaptionPropertiesPanel.tsx
  - src/react-app/components/TrackPropertiesPanel.tsx
  - src/react-app/components/TransitionPropertiesPanel.tsx
  - src/react-app/components/GifSearchPanel.tsx
  - src/react-app/components/RenderSettingsModal.tsx
  - src/react-app/components/SessionManager.tsx
tags:
  - panels
  - ai
  - properties
  - render
  - session
  - remotion
  - captions
  - gif
  - transitions
---

# Panels

## Overview

This module covers all panel and modal components in HyperEdit's UI. These components collectively form the right-panel AI agent suite (Director/AIPromptPanel, DiCaprio, Picasso), the left-panel properties stack (ClipPropertiesPanel, CaptionPropertiesPanel, TrackPropertiesPanel, TransitionPropertiesPanel, MotionGraphicsPanel), and the standalone overlay UIs (GifSearchPanel, RenderSettingsModal, SessionManager). Together they expose all video editing controls, AI-powered generation, and session management to the user without requiring direct interaction with the FFmpeg server or the Remotion CLI.

---

## Key Components

| Component | Default Export | File | Approx. Line Range |
|---|---|---|---|
| `AIPromptPanel` | yes | `AIPromptPanel.tsx` | 1–2328 (render starts at 2328) |
| `DiCaprioPanel` | yes | `DiCaprioPanel.tsx` | 1–743 |
| `PicassoPanel` | yes | `PicassoPanel.tsx` | 1–394 |
| `MotionGraphicsPanel` | yes | `MotionGraphicsPanel.tsx` | 1–566 |
| `ClipPropertiesPanel` | yes | `ClipPropertiesPanel.tsx` | 1–238 |
| `CaptionPropertiesPanel` | yes | `CaptionPropertiesPanel.tsx` | 1–472 |
| `TrackPropertiesPanel` | yes | `TrackPropertiesPanel.tsx` | 1–56 |
| `TransitionPropertiesPanel` | yes | `TransitionPropertiesPanel.tsx` | 1–263 |
| `GifSearchPanel` | yes | `GifSearchPanel.tsx` | 1–268 |
| `RenderSettingsModal` | yes | `RenderSettingsModal.tsx` | 1–943 |
| `SessionManager` | yes | `SessionManager.tsx` | 1–301 |

### Module-level constants (AIPromptPanel.tsx)

| Constant | Type | Lines | Description |
|---|---|---|---|
| `FONT_OPTIONS` | `string[]` | 586–588 | `['Inter','Roboto','Poppins','Montserrat','Oswald','Bebas Neue','Arial','Helvetica']` |
| `suggestions` | `Array<{icon, text}>` | 590–602 | Quick-action chip list rendered in the input toolbar |

### Module-level constants (DiCaprioPanel.tsx)

| Constant | Type | Lines | Description |
|---|---|---|---|
| `SKILLS` | `Array<{id, label, icon, description, requiresType}>` | 46–50 | `animate` (image→video), `restyle` (video style transfer), `remove-bg` (background removal) |
| `QUICK_ACTIONS` | `Array<{icon, text}>` | 52–57 | Four preset prompt strings for the quick-actions popover |

### Module-level constants (PicassoPanel.tsx)

| Constant | Type | Lines | Description |
|---|---|---|---|
| `QUICK_ACTIONS` | `Array<{icon, text}>` | 27–32 | Four preset prompt strings (landscape, square, vertical, abstract) |

### Module-level constants (MotionGraphicsPanel.tsx)

| Constant | Type | Lines | Description |
|---|---|---|---|
| `templateIcons` | `Record<TemplateId, React.ComponentType>` | 28–40 | Maps each of the 11 template IDs to a Lucide icon |
| `componentMap` | `Record<TemplateId, React.ComponentType>` | 42–54 | Maps template IDs to Remotion component classes for live preview |

### Module-level constants (CaptionPropertiesPanel.tsx)

| Constant | Type | Lines | Description |
|---|---|---|---|
| `FONT_OPTIONS` | `Array<{value,label}>` | 11–20 | Eight font family choices |
| `ANIMATION_OPTIONS` | `Array<{value,label}>` | 22–29 | `none`, `karaoke`, `highlight`, `fade`, `pop`, `bounce` |
| `POSITION_OPTIONS` | `Array<{value,label}>` | 31–35 | `top`, `center`, `bottom` |
| `CAPTION_PRESETS` | `Array<{id,label,style}>` | 37–82 | Two presets: `'clean'` (Clean Lower Third) and `'highlight'` (Highlight Mode) |

### Module-level constants (RenderSettingsModal.tsx)

| Constant | Type | Lines | Description |
|---|---|---|---|
| `CODEC_LABELS` | `Record<VideoCodec, string>` | 17–24 | Display names for 6 video codecs |
| `AUDIO_CODEC_LABELS` | `Record<AudioCodec, string>` | 26–31 | Display names for 4 audio codecs |
| `CONTAINER_LABELS` | `Record<ContainerFormat, string>` | 33–38 | Display names for 4 containers |
| `CODEC_AUDIO_MAP` | `Record<VideoCodec, {options, default}>` | 40–47 | Allowed audio codecs per video codec |
| `CONTAINER_MAP` | `Record<string, ContainerFormat[]>` | 50–65 | Allowed containers per `codec+audioCodec` key |
| `CRF_RANGES` | `Record<VideoCodec, {min,max,good,balanced,small}>` | 76–83 | CRF quality boundaries per codec |
| `RESOLUTION_PRESETS` | `Array<{label,w,h}>` | 85–93 | 6 named presets + `Custom` |
| `FPS_OPTIONS` | `number[]` | 95 | `[24, 25, 30, 50, 60]` |
| `SAMPLE_RATE_OPTIONS` | `number[]` | 96 | `[22050, 44100, 48000, 96000]` |
| `AUDIO_BITRATE_OPTIONS` | `string[]` | 97 | `['96k','128k','192k','256k','320k']` |
| `SCALE_OPTIONS` | `Array<{label,value}>` | 98–103 | 0.25×, 0.5×, 1×, 2× |
| `X264_PRESET_OPTIONS` | `Array<{label,value}>` | 104–115 | 10 x264 encoder speed presets |
| `PRORES_PROFILE_OPTIONS` | `Array<{label,value}>` | 116–123 | 6 ProRes profiles |
| `BUILT_IN_PRESETS` | `Preset[]` | 133–197 | 7 named render presets (Social Vertical, YouTube HD, YouTube 4K, Max Quality, Small File, Web Optimized, ProRes Master) |
| `LOCAL_FFMPEG_URL` (GifSearchPanel) | `string` | 27 | `'http://localhost:3333'` |

---

## Interface Definitions

### AIPromptPanel.tsx

#### `TimelineReference` (line 8)
```
type: 'clip' | 'track' | 'timestamp'
id?: string
label: string
details: string
trackId?: string
timestamp?: number
```

#### `AttachedAsset` (line 17, AIPromptPanel)
```
id: string
filename: string
type: 'image' | 'video'
thumbnailUrl?: string | null
```

#### `TimeRange` (line 24)
```
start: number   // seconds
end: number     // seconds
```

#### `TranscriptKeyword` (line 31)
```
keyword: string
timestamp: number
confidence: number
gifUrl?: string
assetId?: string
```

#### `ChatMessage` (line 39, AIPromptPanel)
```
type: 'user' | 'assistant'
text: string
command?: string
explanation?: string
applied?: boolean
extractedKeywords?: TranscriptKeyword[]
isProcessingGifs?: boolean
isCaptionWorkflow?: boolean
isBrollWorkflow?: boolean
isDeadAirWorkflow?: boolean
youtubeChapters?: string
animationAssetId?: string
animationName?: string
isInPlaceEdit?: boolean
```

#### `CaptionOptions` (line 63)
```
highlightColor: string
fontFamily: string
color: string
textOpacity: number
fontSize: number
fontWeight: 'normal' | 'bold' | 'black'
strokeColor: string
strokeWidth: number
backgroundEnabled: boolean
backgroundPadding: number
backgroundRadius: number
backgroundOpacity: number
position: 'bottom' | 'center' | 'top'
positionX: number
positionY: number
animation: CaptionStyle['animation']
```

Default values (line 284–301):
`highlightColor='#FFD700'`, `fontFamily='Inter'`, `color='#FFFFFF'`, `textOpacity=100`, `fontSize=52`, `fontWeight='bold'`, `strokeColor='#000000'`, `strokeWidth=4`, `backgroundEnabled=true`, `backgroundPadding=100`, `backgroundRadius=10`, `backgroundOpacity=45`, `position='bottom'`, `positionX=0`, `positionY=0`, `animation='fade'`

#### `ChapterCutResult` (line 82)
```
chapters: Array<{ start: number; title: string }>
cutsApplied: number
youtubeFormat: string
```

#### `MotionGraphicConfig` (line 88)
```
templateId: TemplateId
props: Record<string, unknown>
duration: number
startTime?: number
```

#### `CustomAnimationResult` (line 95)
```
assetId: string
duration: number
```

#### `BatchAnimationResult` (line 100)
```
assetId: string
filename: string
duration: number
startTime: number
type: 'intro' | 'highlight' | 'transition' | 'callout' | 'outro'
title: string
```

#### `ExtractAudioResult` (line 109)
```
audioAsset: { id: string; filename: string; duration: number }
mutedVideoAsset: { id: string; filename: string; duration: number }
originalAssetId: string
```

#### `ContextualAnimationRequest` (line 123)
```
type: 'intro' | 'outro' | 'transition' | 'highlight'
description?: string
timeRange?: { start: number; end: number }
```

#### `AnimationConcept` (line 130)
```
type: 'intro' | 'outro' | 'transition' | 'highlight'
transcript: string
transcriptPreview: string
contentSummary: string
keyTopics: string[]
scenes: Array<{
  id: string
  type: string
  duration: number
  content: {
    title?: string
    subtitle?: string
    items?: Array<{ icon?: string; label: string; description?: string }>
    stats?: Array<{ value: string; label: string }>
    color?: string
    backgroundColor?: string
  }
}>
totalDuration: number
durationInSeconds: number
backgroundColor: string
startTime?: number
```

#### `ClarifyingQuestion` (line 156)
```
id: string
question: string
options: Array<{ label: string; value: string; description: string; icon?: string }>
context: {
  originalPrompt: string
  category: 'animation' | 'overlay' | 'edit' | 'effect'
}
```

#### `EditTabV1Context` (line 172)
```
assetId: string
filename: string
type: 'video' | 'image' | 'audio'
duration?: number
aiGenerated?: boolean
```

#### `AIPromptPanelProps` (line 180)
```
onApplyEdit?: (command: string) => Promise<void>
onExtractKeywordsAndAddGifs?: () => Promise<void>
onTranscribeAndAddCaptions?: (options?: Partial<CaptionStyle>) => Promise<void>
onGenerateBroll?: () => Promise<void>
onRemoveDeadAir?: () => Promise<{ duration: number; removedDuration: number }>
onChapterCuts?: () => Promise<ChapterCutResult>
onAddMotionGraphic?: (config: MotionGraphicConfig) => Promise<void>
onCreateCustomAnimation?: (description: string, startTime?: number, endTime?: number, attachedAssetIds?: string[], durationSeconds?: number) => Promise<CustomAnimationResult>
onUploadAttachment?: (file: File) => Promise<Asset>
onAnalyzeForAnimation?: (request: ContextualAnimationRequest) => Promise<{ concept: AnimationConcept }>
onRenderFromConcept?: (concept: AnimationConcept) => Promise<CustomAnimationResult>
onCreateContextualAnimation?: (request: ContextualAnimationRequest) => Promise<CustomAnimationResult>  // intentionally unused at line 307 — kept for backwards compat
onGenerateTranscriptAnimation?: () => Promise<CustomAnimationResult>
onGenerateBatchAnimations?: (count: number) => Promise<{ animations: BatchAnimationResult[]; videoDuration: number }>
onExtractAudio?: () => Promise<ExtractAudioResult>
onOpenAnimationInTab?: (assetId: string, animationName: string) => string | undefined
onEditAnimation?: (assetId: string, editPrompt: string, v1Context?: EditTabV1Context, tabIdToUpdate?: string) => Promise<{ assetId: string; duration: number; sceneCount: number }>
isApplying?: boolean
applyProgress?: number
applyStatus?: string
hasVideo?: boolean
clips?: TimelineClip[]
tracks?: Track[]
assets?: Asset[]
currentTime?: number
selectedClipId?: string | null
selectedClipIds?: string[]
onUploadTransition?: (file: File) => Promise<{ transitionId: string; name: string }>
onDeleteTransition?: (transitionId: string) => Promise<void>
onGenerateTransition?: (description: string) => Promise<{ transitionId: string; name: string; code: string }>
onApplyTransition?: (fromClipId: string, toClipId: string, type: string, durationSec: number, customTransitionId?: string) => void
availableTransitions?: { builtIn: string[]; custom: { id: string; name: string }[] }
activeTabId?: string
editTabAssetId?: string
editTabClips?: TimelineClip[]
```

#### `DirectorContext` (line 944, AIPromptPanel internal type)
```
prompt: string
isOnEditTab: boolean
editTabHasAnimation: boolean
editTabAssetId?: string
hasVideo: boolean
hasTimeRange: boolean
timeRangeStart?: number
timeRangeEnd?: number
hasAiAnimationsOnTimeline: boolean
selectedClipIsAiAnimation: boolean
selectedAiAnimationAssetId?: string
```

#### `WorkflowType` (line 928, AIPromptPanel union type)
`'edit-animation' | 'create-animation' | 'batch-animations' | 'motion-graphics' | 'captions' | 'auto-gif' | 'b-roll' | 'dead-air' | 'chapter-cuts' | 'transcript-animation' | 'contextual-animation' | 'extract-audio' | 'ffmpeg-edit' | 'unknown'`

---

### DiCaprioPanel.tsx

#### `DiCaprioSkill` (line 4)
`'animate' | 'restyle' | 'remove-bg'`

#### `AttachedAsset` (line 6, DiCaprioPanel)
```
id: string
filename: string
type: 'image' | 'video' | 'audio'
thumbnailUrl?: string | null
duration?: number
```

#### `ChatMessage` (line 14, DiCaprioPanel)
```
type: 'user' | 'assistant'
text: string
video?: {
  id: string
  filename: string
  thumbnailUrl: string
  streamUrl: string
  duration: number
}
error?: string
awaitingImageSelection?: boolean
awaitingVideoSelection?: boolean
pendingPrompt?: string
pendingSkill?: DiCaprioSkill
```

#### `DiCaprioPanelProps` (line 32)
```
sessionId: string | null
assets: Array<{
  id: string
  filename: string
  type: string
  thumbnailUrl?: string | null
  duration?: number
  aiGenerated?: boolean
}>
onVideoGenerated?: (assetId: string) => void
onRefreshAssets?: () => void
```

---

### PicassoPanel.tsx

#### `ChatMessage` (line 4, PicassoPanel)
```
type: 'user' | 'assistant'
text: string
images?: Array<{
  id: string
  filename: string
  thumbnailUrl: string
  streamUrl: string
  width: number
  height: number
}>
error?: string
awaitingDimension?: boolean
pendingPrompt?: string
```

#### `PicassoPanelProps` (line 21)
```
sessionId: string | null
onImageGenerated?: (assetId: string) => void
onRefreshAssets?: () => void
```

---

### MotionGraphicsPanel.tsx

#### `MotionGraphicsPanelProps` (line 24)
```
onAddToTimeline?: (templateId: TemplateId, props: Record<string, unknown>, duration: number) => void
```

---

### ClipPropertiesPanel.tsx

#### `ClipTransform` (line 5)
```
x?: number
y?: number
scale?: number
rotation?: number
opacity?: number
cropTop?: number
cropBottom?: number
cropLeft?: number
cropRight?: number
```

#### `ClipPropertiesPanelProps` (line 17)
```
clip: TimelineClip | null
asset: Asset | null
onUpdateTransform: (clipId: string, transform: ClipTransform) => void
onClose: () => void
```

---

### CaptionPropertiesPanel.tsx

#### `CaptionPropertiesPanelProps` (line 5)
```
captionData: CaptionData
onUpdateStyle: (styleUpdates: Partial<CaptionStyle>) => void
onClose: () => void
```

---

### TrackPropertiesPanel.tsx

#### `TrackPropertiesPanelProps` (line 3)
```
trackId: string
trackName: string
autoSnap: boolean
onToggleAutoSnap: (enabled: boolean) => void
onClose: () => void
```

---

### TransitionPropertiesPanel.tsx

#### `TransitionPropertiesPanelProps` (line 6)
```
transition: TimelineTransition
clips: TimelineClip[]
onUpdate: (id: string, updates: Partial<Omit<TimelineTransition, 'id'>>) => void
onRemove: (id: string) => void
onClose: () => void
```

---

### GifSearchPanel.tsx

#### `GifResult` (line 4)
```
id: string
title: string
url: string
previewUrl: string
thumbnailUrl: string
width: number
height: number
source: string
```

#### `GifSearchPanelProps` (line 16)
```
sessionId: string
onClose: () => void
onGifAdded: (asset: {
  id: string
  filename: string
  type: string
  thumbnailUrl: string
  streamUrl: string
}) => void
```

---

### RenderSettingsModal.tsx

#### `Preset` (line 127)
```
id: string
label: string
options: Partial<RenderOptions>
```

#### `RenderSettingsModalProps` (line 201)
```
renderOptions: RenderOptions
onClose: () => void
onExport: (options: RenderOptions) => void
onUpdateOptions: (options: RenderOptions) => void
isExporting: boolean
recommendedConcurrency: number
sessionId: string
```

---

### SessionManager.tsx

#### `SessionManagerProps` (line 8)
```
currentSession: SessionInfo | null
saveProjectImmediate: () => Promise<void>
setSession: (s: SessionInfo | null) => void
resetProjectState: () => void
resetLocalState: () => void
```

---

## Methods and Handlers

### AIPromptPanel — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `editTabV1Context` (computed) | 311–330 | Derives V1 clip context from edit tab clips for hybrid asset approach |
| `formatTimeShort(seconds)` | 380–384 | `number → "M:SS"` string |
| `parseTimeString(timeStr)` | 387–408 | `"M:SS"` or `"MM:SS"` or plain seconds → `number \| null` |
| `applyTimeRange()` | 411–419 | Validates and commits `timeRangeInputs` into `timeRange` state |
| `clearTimeRange()` | 422–425 | Resets `timeRange` and `timeRangeInputs` |
| `addReference(ref)` | 428–453 | Adds a timeline reference or promotes image/video assets to `attachedAssets` |
| `removeReference(index)` | 456–464 | Removes from `selectedReferences`; also removes corresponding `attachedAssets` entry |
| `handleFileAttachment(e)` | 467–499 | Uploads files via `onUploadAttachment`, appends valid image/video to `attachedAssets` |
| `removeAttachment(index)` | 502–504 | Removes one entry from `attachedAssets` |
| `clearAttachments()` | 507–509 | Empties `attachedAssets` (called after successful animation creation) |
| `handleDragOver(e)` | 512–519 | Accepts `application/x-hyperedit-asset` drags, sets `isDragOverChat` |
| `handleDragLeave(e)` | 521–527 | Clears `isDragOverChat` when cursor leaves container |
| `handleDrop(e)` | 530–560 | Accepts dropped image assets from asset library; rejects videos/audio |
| `buildReferenceContext()` | 563–584 | Builds `[Time Range: ...] [Clip: ...] \n\n` prefix string for AI prompts |
| `isContextualAnimationPrompt(text)` | 607–651 | Regex classifier returning `{isMatch, type}` for intro/outro/transition/highlight |
| `parseDurationFromPrompt(text)` | 654–685 | Extracts seconds/minutes/keyword from prompt; returns `number \| undefined` |
| `parseTimeRangeFromPrompt(text)` | 688–748 | Parses `M:SS-M:SS`, `Xs-Ys`, `at M:SS`, `from M:SS` patterns; returns `{start,end} \| undefined` |
| `handleContextualAnimationWorkflow(type, description?)` | 751–802 | Calls `onAnalyzeForAnimation`, stores concept in `pendingAnimationConcept`, updates chat |
| `handleApproveAnimation()` | 805–858 | Renders the pending concept via `onRenderFromConcept`, updates chat, clears concept |
| `handleCancelAnimation()` | 861–867 | Clears `pendingAnimationConcept`, appends cancelled message to chat |
| `handleClarificationChoice(questionId, choice)` | 870–919 | Routes user's multi-choice answer to the appropriate workflow |
| `determineWorkflow(ctx)` | 959–1146 | Core "Director" function — pure function mapping `DirectorContext` → `WorkflowType` |
| `handleChapterCutWorkflow()` | 1149–1189 | Calls `onChapterCuts`, formats chapter list, updates chat |
| `pollForResult(jobId, maxAttempts)` | 1192–1222 | Polls `/api/ai-edit/status/${jobId}` every 1 s up to `maxAttempts` (default 60) |
| `handleCaptionWorkflow()` | 1225–1268 | Calls `onTranscribeAndAddCaptions` with `captionOptions`, updates chat |
| `handleAutoGifWorkflow()` | 1271–1311 | Calls `onExtractKeywordsAndAddGifs`, updates chat |
| `parseMotionGraphicFromPrompt(text)` | 1314–1496 | Regex-based extraction — returns `MotionGraphicConfig \| null` for 8 template types |
| `handleCustomAnimationWorkflow(description, startTimeOverride?, endTimeOverride?)` | 1499–1636 | Creates new Remotion animation; uses approval flow if time range given |
| `handleEditAnimationWorkflow(editPrompt, assetId)` | 1639–1707 | Calls `onEditAnimation` with V1 context and tab ID, updates chat in-place |
| `handleMotionGraphicsWorkflow(prompt, startTimeOverride?)` | 1710–1767 | Parses template from prompt via `parseMotionGraphicFromPrompt`, calls `onAddMotionGraphic` |
| `handleBrollWorkflow()` | 1770–1811 | Calls `onGenerateBroll`, updates chat |
| `handleDeadAirWorkflow()` | 1814–1863 | Calls `onRemoveDeadAir`, formats removed duration, handles `ASSET_FILE_MISSING` error |
| `handleTranscriptAnimationWorkflow()` | 1866–1908 | Calls `onGenerateTranscriptAnimation`, updates chat with result |
| `handleBatchAnimationsWorkflow(count)` | 1911–1956 | Calls `onGenerateBatchAnimations(count)`, lists generated animations in chat |
| `handleExtractAudioWorkflow()` | 1959–1999 | Calls `onExtractAudio`, reports audio/video asset filenames in chat |
| `handleSubmit(e)` | 2001–2305 | Main form submit: calls `determineWorkflow`, dispatches to appropriate handler; falls back to `pollForResult` for `ffmpeg-edit` |
| `handleApplyEdit(command, messageIndex)` | 2307–2326 | Calls `onApplyEdit(command)`, marks message as `applied` in chat history |

### DiCaprioPanel — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `attachAsset(asset)` | 103–119 | Sets `attachedAsset`, auto-selects skill based on asset type |
| `clearAttachment()` | 122–125 | Clears `attachedAsset` and `activeSkill` |
| `getFriendlyName(asset)` | 128–136 | Strips UUID prefix and file extension; caps at 20 chars |
| `detectSkill(text)` | 139–165 | Keyword classifier → `DiCaprioSkill \| null` |
| `generateFromImage(videoPrompt, imageId)` | 168–203 | POSTs to `/session/{id}/generate-video` (Kling v1.5), appends video to chat |
| `restyleVideo(stylePrompt, videoId)` | 206–240 | POSTs to `/session/{id}/restyle-video` (LTX-2 19B), appends video to chat |
| `removeBackground(videoId)` | 243–276 | POSTs to `/session/{id}/remove-video-bg` (Bria), appends video to chat |
| `handleAssetSelectFromMessage(assetId, skill, prompt?)` | 279–296 | Handles inline asset picker selection after multi-asset ambiguity |
| `handleSubmit(e)` | 298–387 | Form submit: resolves skill + asset, dispatches to one of three generation functions |
| `getPlaceholder()` | 390–398 | Returns context-appropriate textarea placeholder string |

### PicassoPanel — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `hasDimensionKeywords(text)` | 66–74 | Returns `true` if text contains orientation/ratio keywords |
| `getDimensionAspectRatio(choice)` | 77–83 | Maps `'horizontal' \| 'vertical' \| 'square'` → aspect ratio string |
| `generateImage(imagePrompt, ratio)` | 86–135 | POSTs to `/session/{id}/generate-image` with `{prompt, aspectRatio, resolution:'1K', numImages:1}` |
| `handleDimensionSelect(choice)` | 138–154 | Finds pending prompt from last `awaitingDimension` message, generates with chosen ratio |
| `handleSubmit(e)` | 156–193 | If no dimension keywords: ask; if keywords present: detect ratio then call `generateImage` |

### MotionGraphicsPanel — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `handleSelectTemplate(id)` | 62–65 | Sets `selectedTemplate`, copies `defaultProps` into `templateProps` |
| `handleUpdateProp(key, value)` | 67–69 | Merges single prop into `templateProps` |
| `handleAddToTimeline()` | 71–75 | Calls `onAddToTimeline(selectedTemplate, templateProps, duration)` |
| `handleBack()` | 77–83 | Returns from template → category list, or category → top-level list |
| `renderPreview()` | 86–114 | Renders `@remotion/player` at 30fps with current props; `durationInFrames = duration * 30` |
| `renderPropertyEditors()` | 117–455 | Renders conditional property sections based on `defaultProps` key presence; handles text, name, title, value, label, logoText, tagline, quote, author, role, progress, beforeLabel, afterLabel, intensity, url, styles, types, effects, frameTypes, primaryColor/color |

### ClipPropertiesPanel — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `handleScaleChange(value)` | 32–35 | Merges `{scale}` into clip transform |
| `handleRotationChange(value)` | 37–40 | Merges `{rotation}` into clip transform |
| `handlePositionChange(axis, value)` | 42–45 | Merges `{x}` or `{y}` into clip transform |
| `handleCropChange(side, value)` | 47–50 | Merges `{cropTop\|cropBottom\|cropLeft\|cropRight}` into clip transform |
| `handleReset()` | 52–65 | Resets all transform fields to identity values |

### CaptionPropertiesPanel — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `handleFontChange(value)` | 91–93 | `onUpdateStyle({ fontFamily })` |
| `handleFontSizeChange(value)` | 95–97 | `onUpdateStyle({ fontSize })` |
| `handleFontWeightChange(value)` | 99–101 | `onUpdateStyle({ fontWeight })` |
| `handleColorChange(value)` | 103–105 | `onUpdateStyle({ color })` |
| `handleStrokeColorChange(value)` | 107–109 | `onUpdateStyle({ strokeColor })` |
| `handleStrokeWidthChange(value)` | 111–113 | `onUpdateStyle({ strokeWidth })` |
| `handlePositionChange(value)` | 115–117 | `onUpdateStyle({ position })` |
| `handleAnimationChange(value)` | 119–121 | `onUpdateStyle({ animation })` |
| `handleHighlightColorChange(value)` | 123–125 | `onUpdateStyle({ highlightColor })` |
| `applyPreset(presetId)` | 127–131 | Finds preset by id in `CAPTION_PRESETS`, calls `onUpdateStyle(preset.style)` |
| `textPreview` (computed) | 134–135 | First 3 words of `captionData.words` + `'...'` if more than 3 |

### TrackPropertiesPanel — internal functions

No internal functions beyond the render; `onToggleAutoSnap(!autoSnap)` is called inline on the toggle button click (line 41).

### TransitionPropertiesPanel — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `handleParamChange(key, value)` | 28–31 | Merges single param key into `transition.params` via `onUpdate` |

### GifSearchPanel — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `loadTrending()` | 37–51 | GETs `/session/{id}/giphy/trending?limit=24`, sets `gifs`, sets `mode='trending'` |
| `handleSearch(e?)` | 58–80 | If no query calls `loadTrending`; else GETs `/session/{id}/giphy/search?q=...&limit=24` |
| `handleAddGif(gif)` | 82–102 | POSTs to `/session/{id}/giphy/add` with `{gifUrl, title}`, calls `onGifAdded` on success |

### RenderSettingsModal — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `getValidContainers(codec, audioCodec)` | 67–69 | Looks up `CONTAINER_MAP[codec+audioCodec]`, defaults to `['mp4']` |
| `getDefaultContainer(codec, audioCodec)` | 71–74 | Returns first valid container |
| `update(partial)` | 245–251 | Merges `partial` into `opts`, sets `presetId='custom'`, calls `onUpdateOptions` |
| `applyPreset(presetId)` | 254–270 | Finds preset in `BUILT_IN_PRESETS`, merges over `defaultRenderOptions`, calls `onUpdateOptions` |
| `handleCodecChange(codec)` | 282–294 | Cascades audio codec and container to compatible defaults; sets CRF to `balanced` |
| `handleAudioCodecChange(audioCodec)` | 297–304 | Validates current container against new codec+audio combination |
| `handleResolutionPreset(label)` | 307–316 | Applies preset dimensions or enables custom mode |
| `resolvedResLabel` (computed) | 319–322 | Label string for current resolution |
| `displayCrf` (computed) | 325 | `crfDrag ?? opts.crf` — shows drag value while sliding |
| `crfLabel` (computed) | 326–331 | `'High Quality' \| 'Balanced' \| 'Small File'` based on CRF vs range thresholds |

### RenderSettingsModal — private sub-components

| Function | Lines | Purpose |
|---|---|---|
| `Field({label, children})` | 755–762 | Label + children wrapper |
| `Select<T>({value, options, labels, onChange})` | 764–791 | Styled `<select>` with `ChevronDown` icon |
| `NumberInput({value, min, max, onChange, suffix?})` | 793–821 | Clamped `<input type="number">` with optional suffix |
| `QualityModeButton({active, label, onClick})` | 823–835 | Small toggle button for CRF/Bitrate and tab switching |
| `ToggleSwitch({checked, onChange})` | 837–853 | Accessible ARIA switch |
| `RenderCard({render, isSelected, isRenaming, renameValue, onSelect, onRenameChange, onRenameCommit, onRenameCancel})` | 855–918 | Gallery card with thumbnail, inline rename input, duration/size/date metadata |
| `formatRelativeDate(ts)` | 920–928 | `timestamp → 'just now' \| 'Xm ago' \| 'Xh ago' \| 'Xd ago'` |
| `formatDuration(secs)` | 930–935 | `seconds → 'H:MM:SS' \| 'M:SS'` |
| `formatFileSize(bytes)` | 937–942 | `bytes → 'X.X GB' \| 'X.X MB' \| 'X KB'` |

### SessionManager — internal functions

| Function | Lines | Purpose |
|---|---|---|
| `formatRelativeDate(timestamp)` | 16–25 | `timestamp → 'just now' \| 'Xm ago' \| 'Xh ago' \| 'Xd ago'` |
| `startRename()` | 94–98 | Copies `currentSession.name` into `renameValue`, sets `isRenaming=true` |
| `confirmRename()` | 100–107 | Calls `renameSession(currentSession.sessionId, renameValue)`, clears rename mode |
| `handleRenameKeyDown(e)` | 109–112 | `Enter` → `confirmRename()`, `Escape` → clears rename mode |
| `handleDelete()` | 114–118 | Calls `deleteSession(pendingDelete.sessionId)`, clears `pendingDelete` |
| `toggleDropdown()` | 129–135 | Computes dropdown position from trigger `getBoundingClientRect` before opening |

---

## Data Flow

```text
┌──────────────────────────────────────────────────────────────────────┐
│                          AIPromptPanel                               │
│                                                                      │
│  User types prompt                                                   │
│        │                                                             │
│        ▼                                                             │
│  handleSubmit()                                                      │
│        │                                                             │
│        ├─ buildReferenceContext() ──→ prepends [refs] to prompt      │
│        │                                                             │
│        ├─ parseTimeRangeFromPrompt() ──→ optional time window        │
│        │                                                             │
│        ├─ determineWorkflow(DirectorContext) ──→ WorkflowType        │
│        │        │                                                    │
│        │        ├─ edit-animation    ──→ handleEditAnimationWorkflow  │
│        │        ├─ create-animation  ──→ handleCustomAnimationWorkflow│
│        │        ├─ batch-animations  ──→ handleBatchAnimationsWorkflow│
│        │        ├─ motion-graphics   ──→ handleMotionGraphicsWorkflow │
│        │        ├─ captions          ──→ handleCaptionWorkflow        │
│        │        ├─ auto-gif          ──→ handleAutoGifWorkflow        │
│        │        ├─ b-roll            ──→ handleBrollWorkflow          │
│        │        ├─ dead-air          ──→ handleDeadAirWorkflow        │
│        │        ├─ chapter-cuts      ──→ handleChapterCutWorkflow     │
│        │        ├─ transcript-animation → handleTranscriptAnimation   │
│        │        ├─ extract-audio     ──→ handleExtractAudioWorkflow   │
│        │        └─ ffmpeg-edit       ──→ POST /api/ai-edit/start      │
│        │                                  └─ pollForResult(jobId)     │
│        │                                       └─ GET /api/ai-edit/status │
│        │                                                             │
│        └─ Each workflow handler calls a prop callback               │
│           (onCreateCustomAnimation, onEditAnimation, etc.)          │
│           which is implemented in Home.tsx / useProject              │
│                                                                      │
│  Result written to chatHistory state ──→ re-render chat messages    │
└──────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         DiCaprioPanel                               │
│                                                                      │
│  User attaches asset (+ button or drag) ──→ attachedAsset state     │
│  User selects skill (Animate/Restyle/Remove BG)                     │
│  User submits prompt                                                 │
│        │                                                             │
│        ├─ If image attached  ──→ generateFromImage()                │
│        │      POST /session/{id}/generate-video                     │
│        │                                                             │
│        ├─ If video + restyle ──→ restyleVideo()                     │
│        │      POST /session/{id}/restyle-video                      │
│        │                                                             │
│        └─ If video + bg      ──→ removeBackground()                │
│               POST /session/{id}/remove-video-bg                    │
│                                                                      │
│  On success: calls onRefreshAssets() + onVideoGenerated(assetId)   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         PicassoPanel                                │
│                                                                      │
│  User submits prompt                                                 │
│        │                                                             │
│        ├─ If no dimension keywords ──→ awaitingDimension=true       │
│        │      User picks Horizontal/Vertical/Square                 │
│        │                                                             │
│        └─ If dimension present ──→ detect ratio ──→ generateImage() │
│               POST /session/{id}/generate-image                     │
│               { prompt, aspectRatio, resolution:'1K', numImages:1 } │
│                                                                      │
│  On success: calls onRefreshAssets() + onImageGenerated(assetId)   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       MotionGraphicsPanel                           │
│                                                                      │
│  Category list ──→ Template list ──→ Template editor               │
│                                            │                        │
│                                   renderPreview() via @remotion/player
│                                            │                        │
│                                   handleUpdateProp() on each field  │
│                                            │                        │
│                                   "Add to Timeline" button          │
│                                            │                        │
│                               onAddToTimeline(id, props, duration)  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      ClipPropertiesPanel                            │
│                                                                      │
│  Receives: clip, asset, onUpdateTransform                           │
│  Renders sliders/inputs for scale, rotation, x, y, crop edges      │
│  Each change ──→ onUpdateTransform(clipId, mergedTransform)         │
│  Reset ──→ onUpdateTransform(clipId, identityTransform)             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    CaptionPropertiesPanel                           │
│                                                                      │
│  Receives: captionData, onUpdateStyle                               │
│  Preset buttons ──→ applyPreset() ──→ onUpdateStyle(preset.style)  │
│  Individual controls ──→ onUpdateStyle({ field: value })           │
│  Highlight color shown only when animation='karaoke'|'highlight'    │
│  Background sub-section shown only when backgroundEnabled != false  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      TransitionPropertiesPanel                      │
│                                                                      │
│  Reads paramSchema from getTransitionParams(transition.transitionFileId)
│  Dynamic params rendered per type: number→range, boolean→toggle,   │
│   string+options→select, color→color picker, default→text input    │
│  freeForm toggle: slider (max 5s) vs number input (unbounded)      │
│  "Remove Transition" ──→ onRemove(transition.id)                   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         GifSearchPanel                              │
│                                                                      │
│  Mount ──→ loadTrending() ──→ GET /session/{id}/giphy/trending      │
│  Search form ──→ handleSearch() ──→ GET /session/{id}/giphy/search  │
│  GIF click ──→ handleAddGif() ──→ POST /session/{id}/giphy/add      │
│                 └─→ onGifAdded(asset)                               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       RenderSettingsModal                           │
│                                                                      │
│  Tabs: "Render Settings" | "Gallery"                               │
│  Settings tab:                                                      │
│    Preset select ──→ applyPreset() ──→ onUpdateOptions()           │
│    Codec/audio/container cascade via handleCodecChange /            │
│      handleAudioCodecChange                                         │
│    CRF slider with crfDrag state for live label                    │
│    Export button ──→ onExport(opts)                                │
│  Gallery tab:                                                       │
│    useDeliverables() ──→ fetchRenders(sessionId)                   │
│    RenderCard grid with select, rename, download, delete           │
│    Delete confirmation dialog via createPortal                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         SessionManager                              │
│                                                                      │
│  Trigger button (FolderOpen icon + name) ──→ toggleDropdown()      │
│  Dropdown portaled to document.body (fixed position)               │
│  Current session: rename in-place via isRenaming state             │
│  Other sessions list: click ──→ switchToSession()                  │
│                        trash icon ──→ setPendingDelete()            │
│  "New Session" ──→ createAndSwitch()                               │
│  Delete confirm dialog also portaled to body (z-9999)              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## State Variables

### AIPromptPanel local state
| Variable | Type | Lines | Notes |
|---|---|---|---|
| `prompt` | `string` | 257 | Current textarea value |
| `isProcessing` | `boolean` | 258 | Spinner/lock during any async workflow |
| `processingStatus` | `string` | 259 | Status text shown in processing banner |
| `chatHistory` | `ChatMessage[]` | 260 | All chat messages including assistant responses |
| `showCaptionOptions` | `boolean` | 261 | Reveals caption style panel |
| `showQuickActions` | `boolean` | 262 | Quick-actions popover |
| `showReferencePicker` | `boolean` | 263 | Reference picker popover |
| `selectedReferences` | `TimelineReference[]` | 264 | References attached to next message |
| `showTimeRangePicker` | `boolean` | 265 | Time range picker popover |
| `timeRange` | `TimeRange \| null` | 266 | Active time scope |
| `timeRangeInputs` | `{start,end}` | 267 | Raw text in time range inputs |
| `showMotionGraphicsModal` | `boolean` | 268 | (Set but never rendered inline in this file) |
| `attachedAssets` | `AttachedAsset[]` | 269 | Images/videos for next animation creation |
| `isUploadingAttachment` | `boolean` | 270 | Upload-in-progress indicator |
| `isDragOverChat` | `boolean` | 271 | Asset drag-over highlight |
| `showTransitionsPanel` | `boolean` | 272 | Transitions sub-panel visibility |
| `selectedTransitionType` | `string` | 273 | Default `'crossfade'` |
| `selectedCustomTransitionId` | `string \| null` | 274 | Selected custom transition |
| `transitionDuration` | `number` | 275 | Default `0.5` seconds |
| `generateTransitionPrompt` | `string` | 276 | Prompt for AI-generated transitions |
| `isGeneratingTransition` | `boolean` | 277 | Transition generation in progress |
| `captionOptions` | `CaptionOptions` | 284–301 | Caption style config with defaults |
| `showAdvancedCaptionOptions` | `boolean` | 302 | Advanced section toggle |
| `pendingQuestion` | `ClarifyingQuestion \| null` | 303 | Pending multi-choice clarification |
| `pendingAnimationConcept` | `AnimationConcept \| null` | 304 | Animation concept awaiting approval |

### DiCaprioPanel local state
| Variable | Type | Lines | Notes |
|---|---|---|---|
| `prompt` | `string` | 65 | Textarea value |
| `messages` | `ChatMessage[]` | 66 | Chat history |
| `isGenerating` | `boolean` | 67 | API call in progress |
| `duration` | `string` | 68 | Fixed at `'5'` — setter unused, value unused in API calls |
| `showQuickActions` | `boolean` | 69 | Quick-actions popover |
| `showAssetPicker` | `boolean` | 70 | Asset picker popover |
| `attachedAsset` | `AttachedAsset \| null` | 71 | Single attached asset |
| `activeSkill` | `DiCaprioSkill \| null` | 72 | Selected skill tab |

### PicassoPanel local state
| Variable | Type | Lines | Notes |
|---|---|---|---|
| `prompt` | `string` | 39 | Textarea value |
| `messages` | `ChatMessage[]` | 40 | Chat history |
| `isGenerating` | `boolean` | 41 | API call in progress |
| `aspectRatio` | `string` | 42 | Fixed at `'16:9'` — setter unused, used as fallback default |
| `showQuickActions` | `boolean` | 43 | Quick-actions popover |

### MotionGraphicsPanel local state
| Variable | Type | Lines |
|---|---|---|
| `selectedTemplate` | `TemplateId \| null` | 57 |
| `templateProps` | `Record<string, unknown>` | 58 |
| `duration` | `number` | 59 — default `3` |
| `selectedCategory` | `string \| null` | 60 |

### TransitionPropertiesPanel local state
| Variable | Type | Lines |
|---|---|---|
| `freeForm` | `boolean` | 24 — init: `transition.durationSec > 5` |

### GifSearchPanel local state
| Variable | Type | Lines |
|---|---|---|
| `searchQuery` | `string` | 30 |
| `gifs` | `GifResult[]` | 31 |
| `loading` | `boolean` | 32 |
| `addingGifId` | `string \| null` | 33 |
| `error` | `string \| null` | 34 |
| `mode` | `'trending' \| 'search'` | 35 |

### RenderSettingsModal local state
| Variable | Type | Lines |
|---|---|---|
| `opts` | `RenderOptions` | 220 |
| `customResolution` | `boolean` | 221 |
| `crfDrag` | `number \| null` | 222 |
| `activeTab` | `'settings' \| 'gallery'` | 223 |
| `renamingId` | `string \| null` | 224 |
| `renameValue` | `string` | 225 |

### SessionManager local state
| Variable | Type | Lines |
|---|---|---|
| `isOpen` | `boolean` | 34 |
| `isRenaming` | `boolean` | 35 |
| `renameValue` | `string` | 36 |
| `pendingDelete` | `SessionSummary \| null` | 37 |
| `dropdownPos` | `{top, left}` | 42 |

---

## Connections

- [[useProject]] — provides `TimelineClip`, `Asset`, `Track`, `CaptionStyle`, `CaptionData`, `TimelineTransition`, `RenderOptions`, `VideoCodec`, `AudioCodec`, `ContainerFormat`, `HwAccelMode`, `defaultRenderOptions`, `SessionInfo` types; `AIPromptPanelProps` callbacks implemented in `Home.tsx` calling `useProject` mutations
- [[useDeliverables]] — consumed by `RenderSettingsModal` for the gallery tab (fetchRenders, deleteRenders, renameRender, toggleSelect, etc.)
- [[useSessionManager]] — consumed by `SessionManager` (fetchSessions, renameSession, switchToSession, deleteSession, createAndSwitch)
- [[Home]] — mounts all panels; owns the `activeTabId` / `editTabAssetId` / `editTabClips` values passed to `AIPromptPanel`; implements all `AIPromptPanelProps` callbacks
- [[remotion-templates]] — `MotionGraphicsPanel` imports all 11 template components and `MOTION_TEMPLATES` / `TEMPLATE_CATEGORIES`; `AIPromptPanel` imports `MOTION_TEMPLATES` and `TemplateId` for `parseMotionGraphicFromPrompt`
- [[transitions-registry]] — `TransitionPropertiesPanel` calls `getTransitionParams`, `getTransitionMeta`, `getRegisteredTransitions`
- [[AssetLibrary]] — `DiCaprioPanel` asset picker and drag-drop in `AIPromptPanel` receive assets already loaded by the asset library
- [[local-ffmpeg-server]] — all API calls target `http://localhost:3333`; GifSearchPanel, DiCaprioPanel, PicassoPanel hit this directly; AIPromptPanel callbacks are routed through `Home.tsx` which calls the server

---

## Known Issues

### Disabled / Unused Code

- **`onCreateContextualAnimation` prop** (AIPromptPanel line 233, 307): The prop is accepted in `AIPromptPanelProps` but immediately discarded with `void _onCreateContextualAnimation` at line 307. A comment says it is "kept for backwards compatibility." It is never called anywhere in the file.

- **`duration` setter in DiCaprioPanel** (line 68): `const [duration] = useState('5')` — the setter is intentionally omitted, making the duration permanently fixed at `'5'`. The value is passed to `generateFromImage` as `parseInt(duration)` but never exposed to the user.

- **`aspectRatio` setter in PicassoPanel** (line 42): `const [aspectRatio] = useState('16:9')` — setter is intentionally omitted. `aspectRatio` is only used as the fallback default ratio when no dimension keywords are detected but `hasDimensionKeywords` returned true for non-standard keywords; in practice this case is unreachable because `getDimensionAspectRatio` maps all three selectable choices explicitly.

- **`showMotionGraphicsModal` state in AIPromptPanel** (line 268): The state is declared and never set to `true` inside the file; no modal render depends on it in the JSX seen in the file. This appears to be dead state left over from an earlier approach.

- **`selectedClipIds` prop in AIPromptPanel** (line 210): Declared in `AIPromptPanelProps` and destructured at line 245, but never read anywhere in the component body — passed but ignored.

- **`tracks` prop in AIPromptPanel** (line 204): Declared in `AIPromptPanelProps`, destructured (not visible in read portion), but not referenced in any of the workflow handlers or `determineWorkflow`.

- **`pollForResult` / `/api/ai-edit/*` endpoints** (lines 1192–1222, 2261–2281): The FFmpeg-edit workflow posts to `/api/ai-edit/start` and polls `/api/ai-edit/status/{jobId}`. According to the architecture documentation the Cloudflare Worker only generates FFmpeg commands, it does not execute them. Whether these endpoints are functional in local development is unclear — no matching route exists in the `CLAUDE.md` endpoint table for the local FFmpeg server.

### Fragile Patterns

- **`pendingAnimationConcept.startTime` injection** (AIPromptPanel line 1540): The concept returned by `onAnalyzeForAnimation` does not include `startTime` — it is injected ad-hoc with `{ ...concept, startTime: startTimeOverride }`. If `onRenderFromConcept` does not read `startTime` from the concept object this value is silently ignored.

- **`GifSearchPanel` suggestion click hack** (line 165–169): Sets `searchQuery` then uses `setTimeout(0)` to dispatch a synthetic `submit` event on the first `<form>` found in the document. This is fragile — it assumes only one `<form>` exists in the viewport at the moment of the click.

- **`truncatedName` with garbled character** (SessionManager line 126): The truncation uses `displayName.substring(0, 20) + '���'` — the replacement character is a literal `U+FFFD` rendering glitch in the source file. The intended character is likely `…` (ellipsis).

- **Gallery tab overlay implementation** (RenderSettingsModal lines 630–711): The gallery tab is rendered as `position: absolute; inset: 0` over the settings tab rather than unmounting it. The settings tab is made `invisible` (Tailwind `invisible` class) but remains in the DOM and is not `aria-hidden`. This can confuse screen readers.

- **Hardware acceleration note** (RenderSettingsModal line 590): The info tooltip explicitly states "Currently only works with macOS VideoToolbox. Infrastructure for future NVENC/custom FFmpeg support." — the feature is partially implemented.

- **`editTabAssetId?.startsWith('edit-')` heuristic** (AIPromptPanel line 2027): Manual (non-AI) edit tabs are identified by checking whether the asset ID starts with `'edit-'`. This is a naming convention assumption, not a typed discriminant.
