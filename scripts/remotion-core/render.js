import { mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { parseSpecInput } from './spec.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');
const remotionEntry = resolve(projectRoot, 'src/remotion/index.tsx');

let cachedBundlePromise = null;

async function getBundleUrl() {
  if (!cachedBundlePromise) {
    cachedBundlePromise = bundle({
      entryPoint: remotionEntry,
      webpackOverride: (config) => config,
      enableCaching: true,
      onProgress: ({ progress }) => {
        if (progress === 1) {
          console.log('[Remotion] Bundle ready');
        }
      },
    });
  }

  return cachedBundlePromise;
}

function withDefaults(spec) {
  const { spec: parsedSpec } = parseSpecInput(spec || {}, {
    source: 'renderSpecWithRemotion',
  });

  return {
    ...parsedSpec,
    settings: {
      width: parsedSpec?.settings?.width || 1920,
      height: parsedSpec?.settings?.height || 1080,
      fps: parsedSpec?.settings?.fps || 30,
      backgroundColor: parsedSpec?.settings?.backgroundColor || '#000000',
    },
    clips: parsedSpec?.clips || [],
    captions: parsedSpec?.captions || [],
    voiceover: parsedSpec?.voiceover || [],
    tracks: parsedSpec?.tracks || [],
    transitions: parsedSpec?.transitions || [],
  };
}

export async function renderSpecWithRemotion({
  spec,
  outputPath,
  compositionId = 'ProjectTimeline',
  preview = false,
  codec,
  imageFormat = 'jpeg',
  logLevel = 'info',
  concurrency,
}) {
  if (!spec) {
    throw new Error('spec is required for renderSpecWithRemotion');
  }

  if (!outputPath) {
    throw new Error('outputPath is required for renderSpecWithRemotion');
  }

  const normalizedSpec = withDefaults(spec);
  await mkdir(dirname(outputPath), { recursive: true });

  const serveUrl = await getBundleUrl();
  const inputProps = { spec: normalizedSpec };

  const composition = await selectComposition({
    id: compositionId,
    serveUrl,
    inputProps,
  });

  const resolvedCodec = codec || (preview ? 'h264' : 'h264');

  const renderOptions = {
    serveUrl,
    composition,
    codec: resolvedCodec,
    outputLocation: outputPath,
    inputProps,
    imageFormat,
    overwrite: true,
    logLevel,
    concurrency,
    crf: preview ? 30 : 20,
    audioCodec: 'aac',
  };

  await renderMedia(renderOptions);

  return {
    outputPath,
    compositionId,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
  };
}

export async function renderVariantBatch({
  variants,
  outDir,
  prefix = 'variant',
  preview = false,
  compositionId = 'ProjectTimeline',
  logLevel = 'info',
}) {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error('variants must be a non-empty array');
  }

  const results = [];

  for (let i = 0; i < variants.length; i += 1) {
    const spec = variants[i];
    const outputPath = resolve(outDir, `${prefix}-${String(i + 1).padStart(2, '0')}.mp4`);
    const result = await renderSpecWithRemotion({
      spec,
      outputPath,
      compositionId,
      preview,
      logLevel,
    });
    results.push(result);
  }

  return results;
}
