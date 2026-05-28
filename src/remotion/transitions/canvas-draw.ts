export type CanvasDrawFn = (
  ctx: CanvasRenderingContext2D,
  from: CanvasImageSource | null,
  to: CanvasImageSource | null,
  progress: number,
  width: number,
  height: number,
  params: Record<string, number | string | boolean>,
) => void;

function getSourceDimensions(source: CanvasImageSource): { sw: number; sh: number } {
  if (source instanceof HTMLVideoElement) {
    return { sw: source.videoWidth || 1, sh: source.videoHeight || 1 };
  }
  if (source instanceof HTMLImageElement) {
    return { sw: source.naturalWidth || 1, sh: source.naturalHeight || 1 };
  }
  return { sw: 1920, sh: 1080 };
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const { sw, sh } = getSourceDimensions(source);
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.drawImage(source, dx, dy, dw, dh);
}

function easeOutPoly3(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const TAU = Math.PI * 2;

// --- Draw functions ---

const drawCrossfade: CanvasDrawFn = (ctx, from, to, progress, w, h) => {
  if (from) {
    ctx.globalAlpha = 1 - progress;
    drawCover(ctx, from, 0, 0, w, h);
  }
  if (to) {
    ctx.globalAlpha = progress;
    drawCover(ctx, to, 0, 0, w, h);
  }
  ctx.globalAlpha = 1;
};

const drawDipToBlack: CanvasDrawFn = (ctx, from, to, progress, w, h) => {
  const isFirstHalf = progress < 0.5;
  const blackOpacity = isFirstHalf
    ? Math.min(1, progress * 2)
    : Math.min(1, 2 * (1 - progress));

  if (isFirstHalf && from) {
    drawCover(ctx, from, 0, 0, w, h);
  } else if (!isFirstHalf && to) {
    drawCover(ctx, to, 0, 0, w, h);
  }

  ctx.globalAlpha = blackOpacity;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
};

const drawSlideLeft: CanvasDrawFn = (ctx, from, to, progress, w, h) => {
  const fromX = -progress * w;
  const toX = (1 - progress) * w;

  if (from) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(fromX, 0, w, h);
    ctx.clip();
    drawCover(ctx, from, fromX, 0, w, h);
    ctx.restore();
  }
  if (to) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(toX, 0, w, h);
    ctx.clip();
    drawCover(ctx, to, toX, 0, w, h);
    ctx.restore();
  }
};

const drawSlideRight: CanvasDrawFn = (ctx, from, to, progress, w, h) => {
  const fromX = progress * w;
  const toX = -(1 - progress) * w;

  if (from) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(fromX, 0, w, h);
    ctx.clip();
    drawCover(ctx, from, fromX, 0, w, h);
    ctx.restore();
  }
  if (to) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(toX, 0, w, h);
    ctx.clip();
    drawCover(ctx, to, toX, 0, w, h);
    ctx.restore();
  }
};

const drawFacecamTransitionBox: CanvasDrawFn = (ctx, from, to, progress, w, h, params) => {
  const scale = (params.scale as number) ?? 500;
  const xOffset = (params.xOffset as number) ?? 350;
  const yOffset = (params.yOffset as number) ?? 350;
  const wipeColor = (params.wipeColor as string) || '#c3b091';
  const sourceZoom = (params.sourceZoom as number) ?? 1;
  const sourcePanX = (params.sourcePanX as number) ?? 0;
  const sourcePanY = (params.sourcePanY as number) ?? 0;

  const boxWidth = scale;
  const boxHeight = scale * (9 / 16);
  const cx = xOffset;
  const cy = h - yOffset;
  const maxR = Math.sqrt(w * w + h * h);

  const totalProgress = Math.min(1, Math.max(0, progress));
  const wipe1Progress = easeOutPoly3(totalProgress);
  const wipe2Raw = totalProgress < 0.5 ? 0 : (totalProgress - 0.5) / 0.5;
  const wipe2Progress = easeOutPoly3(Math.min(1, Math.max(0, wipe2Raw)));

  const r1 = wipe1Progress * maxR;
  const r2 = wipe2Progress * maxR;

  const rectX = cx - boxWidth / 2;
  const rectY = cy - boxHeight / 2;

  // Base layer: FROM fullscreen
  if (from) {
    drawCover(ctx, from, 0, 0, w, h);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  }

  // Wipe 1: cream circle expanding
  if (r1 > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r1, 0, TAU);
    ctx.fillStyle = wipeColor;
    ctx.fill();
    ctx.restore();
  }

  // Wipe 2: circle clip revealing TO + facecam box
  if (r2 > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r2, 0, TAU);
    ctx.clip();

    // TO clip fills inside the circle
    if (to) {
      drawCover(ctx, to, 0, 0, w, h);
    }

    // Facecam box: FROM with zoom/pan, clipped to rect
    ctx.save();
    ctx.beginPath();
    ctx.rect(rectX, rectY, boxWidth, boxHeight);
    ctx.clip();

    ctx.fillStyle = '#000';
    ctx.fillRect(rectX, rectY, boxWidth, boxHeight);

    if (from) {
      ctx.translate(w / 2, h / 2);
      ctx.scale(sourceZoom, sourceZoom);
      ctx.translate((sourcePanX / 100) * w, (sourcePanY / 100) * h);
      ctx.translate(-w / 2, -h / 2);
      drawCover(ctx, from, 0, 0, w, h);
    }

    ctx.restore(); // rect clip
    ctx.restore(); // circle clip
  }
};

const drawStaticFacecam: CanvasDrawFn = (ctx, from, to, _progress, w, h, params) => {
  const scale = (params.scale as number) ?? 500;
  const xOffset = (params.xOffset as number) ?? 350;
  const yOffset = (params.yOffset as number) ?? 350;
  const sourceZoom = (params.sourceZoom as number) ?? 1;
  const sourcePanX = (params.sourcePanX as number) ?? 0;
  const sourcePanY = (params.sourcePanY as number) ?? 0;

  const boxWidth = scale;
  const boxHeight = scale * (9 / 16);
  const cx = xOffset;
  const cy = h - yOffset;
  const rectX = cx - boxWidth / 2;
  const rectY = cy - boxHeight / 2;

  // Background: TO fullscreen
  if (to) {
    drawCover(ctx, to, 0, 0, w, h);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  }

  // Facecam box: FROM with zoom/pan
  ctx.save();
  ctx.beginPath();
  ctx.rect(rectX, rectY, boxWidth, boxHeight);
  ctx.clip();

  ctx.fillStyle = '#000';
  ctx.fillRect(rectX, rectY, boxWidth, boxHeight);

  if (from) {
    ctx.translate(w / 2, h / 2);
    ctx.scale(sourceZoom, sourceZoom);
    ctx.translate((sourcePanX / 100) * w, (sourcePanY / 100) * h);
    ctx.translate(-w / 2, -h / 2);
    drawCover(ctx, from, 0, 0, w, h);
  }

  ctx.restore();
};

// --- Registry ---

const canvasDraws = new Map<string, CanvasDrawFn>();

canvasDraws.set('builtin-crossfade', drawCrossfade);
canvasDraws.set('builtin-dip-to-black', drawDipToBlack);
canvasDraws.set('builtin-slide-left', drawSlideLeft);
canvasDraws.set('builtin-slide-right', drawSlideRight);
canvasDraws.set('facecamtransitionbox', drawFacecamTransitionBox);
canvasDraws.set('staticfacecam', drawStaticFacecam);

export function getCanvasDraw(id: string): CanvasDrawFn {
  return canvasDraws.get(id) ?? drawCrossfade;
}

export type VolumeHint = {
  fromVolume: number;
  toVolume: number;
};

export function getTransitionVolumes(id: string, progress: number): VolumeHint {
  if (id === 'builtin-dip-to-black') {
    const fromVol = progress < 0.5 ? 1 - progress * 2 : 0;
    const toVol = progress < 0.5 ? 0 : (progress - 0.5) * 2;
    return { fromVolume: fromVol, toVolume: toVol };
  }
  if (id === 'facecamtransitionbox' || id === 'staticfacecam') {
    return { fromVolume: 1, toVolume: 1 };
  }
  // crossfade / slides: linear crossfade
  return { fromVolume: 1 - progress, toVolume: progress };
}
