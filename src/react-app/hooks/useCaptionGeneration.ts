import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type {
  Asset,
  CaptionData,
  CaptionStyle,
  CaptionWord,
  SessionInfo,
  TimelineClip,
} from './useProject';

// Caption chunking: a new caption starts at a speech pause or the word cap
const PAUSE_THRESHOLD = 0.7; // seconds
const MAX_WORDS_PER_CHUNK = 5;

interface TranscribedWord {
  text: string;
  start: number;
  end: number;
}

interface TranscriptionChunk {
  words: TranscribedWord[];
  start: number;
  end: number;
}

// Split words into caption-sized chunks on natural speech pauses or the cap
function chunkWords(words: TranscribedWord[]): TranscriptionChunk[] {
  const chunks: TranscriptionChunk[] = [];
  let current: TranscribedWord[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prev = words[i - 1];
    const hasSignificantPause = prev && (word.start - prev.end) >= PAUSE_THRESHOLD;

    if (current.length > 0 && (hasSignificantPause || current.length >= MAX_WORDS_PER_CHUNK)) {
      chunks.push({ words: current, start: current[0].start, end: current[current.length - 1].end });
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) {
    chunks.push({ words: current, start: current[0].start, end: current[current.length - 1].end });
  }
  return chunks;
}

interface UseCaptionGenerationDeps {
  session: SessionInfo | null;
  assets: Asset[];
  clips: TimelineClip[];
  clipsRef: MutableRefObject<TimelineClip[]>;
  getCaptionData: (clipId: string) => CaptionData | null;
  addCaptionClipsBatch: (
    captions: Array<{
      words: CaptionWord[];
      start: number;
      duration: number;
      style?: Partial<CaptionStyle>;
      generated?: boolean;
    }>
  ) => TimelineClip[];
  deleteCaptionClips: (clipIds: string[]) => void;
  saveProject: () => Promise<void>;
}

// The caption-generation workflow: transcribe the video on V1 (respecting its
// trim window), chunk the words, and replace the previous generated batch.
// Owner-decided semantics (2026-07-16): regeneration replaces silently; the
// only prompts are (a) when hand-edited words would be wiped and (b) when the
// source clip was edited while whisper ran.
export function useCaptionGeneration({
  session,
  assets,
  clips,
  clipsRef,
  getCaptionData,
  addCaptionClipsBatch,
  deleteCaptionClips,
  saveProject,
}: UseCaptionGenerationDeps) {
  // Guards against concurrent transcriptions (double-click = two whisper runs
  // racing two caption batches in)
  const inFlightRef = useRef(false);

  const transcribeAndAddCaptions = useCallback(async (options?: Partial<CaptionStyle>) => {
    if (!session) {
      throw new Error('No session available');
    }
    if (inFlightRef.current) {
      throw new Error('A transcription is already running — wait for it to finish');
    }

    // Pick the transcription target from the MAIN timeline: the earliest V1
    // clip that references a video asset. Picking "first video asset in the
    // library" is wrong with multiple sources — the library's order even
    // changes across server restarts (assets are restored in disk order), which
    // silently switches the transcribed asset and loses the trim window with
    // it (observed: full-length captions for an asset that wasn't on V1).
    // Captions always land on the main timeline (addCaptionClipsBatch), so the
    // lookup must use main clips — activeClips may be a tab's clips.
    const v1Candidates = clips
      .filter(c => c.trackId === 'V1' && c.assetId)
      .sort((a, b) => a.start - b.start);
    let v1Clip: TimelineClip | undefined;
    let videoAsset: Asset | undefined;
    for (const candidate of v1Candidates) {
      const asset = assets.find(a => a.id === candidate.assetId && a.type === 'video');
      if (asset) {
        v1Clip = candidate;
        videoAsset = asset;
        break;
      }
    }
    // Fallback (no video clip on V1): previous behavior — first non-AI video
    if (!videoAsset) {
      videoAsset = assets.find(a => a.type === 'video' && !a.aiGenerated) || assets.find(a => a.type === 'video');
    }

    if (!videoAsset || videoAsset.type !== 'video') {
      throw new Error('Please upload a video first');
    }

    // Regeneration replaces previously GENERATED captions outright — no
    // prompt: the last saved generation is simply whatever loads with the
    // project, and a new run supersedes it. Manual text clips carry no
    // `generated` flag and are never touched.
    const generatedClipIds = clips
      .filter(c => c.trackId === 'T1' && getCaptionData(c.id)?.generated)
      .map(c => c.id);

    // Warn only when the wipe would destroy hand-edited words — the one case
    // where a human decision is genuinely needed. No per-clip skip logic by
    // design; regeneration always replaces the whole generated set.
    const editedCount = generatedClipIds.filter(id => getCaptionData(id)?.wordsEdited).length;
    if (editedCount > 0) {
      const proceed = confirm(
        `Generating captions will wipe and replace the caption track, including ${editedCount} caption${editedCount === 1 ? '' : 's'} you edited by hand.\n\n` +
        'OK = continue and replace\nCancel = keep what you have'
      );
      if (!proceed) {
        throw new Error('Caption generation canceled — existing captions kept.');
      }
    }

    inFlightRef.current = true;
    try {
      // Call the transcribe endpoint with trim bounds
      const response = await fetch(`http://localhost:3333/session/${session.sessionId}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: videoAsset.id,
          startTime: v1Clip?.inPoint ?? 0,
          endTime: v1Clip?.outPoint ?? undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to transcribe video');
      }

      const data = await response.json();
      console.log('Transcription result:', data);

      // The transcript matches the trim window that was sent. If the clip was
      // edited while whisper ran we can't tell whether the edit invalidated it
      // (a move elsewhere is harmless, a re-trim isn't — classifying edit
      // types isn't worth the code), so the user decides. A pure move
      // re-anchors to the live start either way.
      const v1Now = v1Clip ? clipsRef.current.find(c => c.id === v1Clip.id) : undefined;
      if (v1Clip && (!v1Now || v1Now.inPoint !== v1Clip.inPoint || v1Now.outPoint !== v1Clip.outPoint)) {
        const applyAnyway = confirm(
          'The clip was edited while captions were generating.\n\n' +
          'OK = add the captions anyway (they may be misaligned if the trim changed)\n' +
          'Cancel = discard this generation'
        );
        if (!applyAnyway) {
          throw new Error('Captions discarded — the clip was edited during generation.');
        }
      }
      const anchorClip = v1Now ?? v1Clip;

      if (!data.words || data.words.length === 0) {
        throw new Error(v1Clip
          ? 'No speech detected in the selected clip range. Make sure the clip covers audible speech.'
          : 'No speech detected in video. Make sure your video has audible speech.');
      }

      // Word timestamps are relative to the trimmed audio the server extracted
      // for the [inPoint, outPoint] window. Whisper can overrun the audio's
      // end slightly, so clamp words to the window — caption clips must never
      // extend past the source clip's span on the timeline.
      const windowDuration = v1Clip ? v1Clip.outPoint - v1Clip.inPoint : Infinity;
      const words: TranscribedWord[] = (data.words as TranscribedWord[])
        .filter(w => w.start < windowDuration)
        .map(w => (w.end > windowDuration ? { ...w, end: windowDuration } : w));

      const chunks = chunkWords(words);

      // Create all caption clips at once (batched for performance)
      const captionsToAdd = chunks.map(chunk => {
        // Floor degenerate whisper timestamps (start==end would make an
        // invisible 0-duration clip) but never extend past the clip window
        const maxDuration = Number.isFinite(windowDuration) ? windowDuration - chunk.start : Infinity;
        const duration = Math.min(Math.max(0.2, chunk.end - chunk.start), maxDuration);
        // Adjust word timestamps to be relative to chunk start
        const relativeWords = chunk.words.map(w => ({
          ...w,
          start: w.start - chunk.start,
          end: w.end - chunk.start,
        }));
        return {
          words: relativeWords,
          start: chunk.start + (anchorClip?.start ?? 0),
          duration,
          style: options ? { ...options } : {},
          generated: true,
        };
      });

      addCaptionClipsBatch(captionsToAdd);
      if (generatedClipIds.length > 0) {
        deleteCaptionClips(generatedClipIds);
      }
      await saveProject();
      console.log(`Created ${chunks.length} caption clips${generatedClipIds.length > 0 ? `, replaced ${generatedClipIds.length}` : ''}`);

      return data;
    } finally {
      inFlightRef.current = false;
    }
  }, [session, assets, clips, clipsRef, getCaptionData, addCaptionClipsBatch, deleteCaptionClips, saveProject]);

  return { transcribeAndAddCaptions };
}
