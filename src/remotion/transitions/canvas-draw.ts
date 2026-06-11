export type CanvasImageSource = HTMLVideoElement | HTMLImageElement;

export type CanvasDrawFn = (
  ctx: CanvasRenderingContext2D,
  from: CanvasImageSource | null,
  to: CanvasImageSource | null,
  progress: number,
  width: number,
  height: number,
  params: Record<string, number | string | boolean>,
) => void;

function drawCover(
  ctx: CanvasRenderingContext2D,
  el: CanvasImageSource,
  x: number, y: number, w: number, h: number,
) {
  const sw = el instanceof HTMLVideoElement ? el.videoWidth : (el as HTMLImageElement).naturalWidth;
  const sh = el instanceof HTMLVideoElement ? el.videoHeight : (el as HTMLImageElement).naturalHeight;
  if (!sw || !sh) { ctx.drawImage(el, x, y, w, h); return; }
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

const draws: Record<string, CanvasDrawFn> = {
  // Draw from at full opacity first so canvas is fully opaque (covers underlying video
  // elements). Then draw to at progress alpha on top → clean linear blend. Null sources
  // fill black so canvas stays opaque for fade-from/to-black scenarios.
  'builtin-crossfade': (ctx, from, to, progress, w, h) => {
    ctx.globalAlpha = 1;
    if (from) { drawCover(ctx, from, 0, 0, w, h); }
    else       { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
    ctx.globalAlpha = progress;
    if (to) { drawCover(ctx, to, 0, 0, w, h); }
    else     { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
    ctx.globalAlpha = 1;
  },

  'builtin-dip-to-black': (ctx, from, to, progress, w, h) => {
    const isFirst = progress < 0.5;
    const blackAlpha = isFirst ? progress * 2 : (1 - progress) * 2;
    const src = isFirst ? from : to;
    ctx.globalAlpha = 1;
    if (src) { drawCover(ctx, src, 0, 0, w, h); }
    else      { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
    ctx.fillStyle = '#000';
    ctx.globalAlpha = blackAlpha;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  },

  'builtin-slide-left': (ctx, from, to, progress, w, h) => {
    if (from) {
      ctx.save();
      ctx.beginPath(); ctx.rect(-progress * w, 0, w, h); ctx.clip();
      drawCover(ctx, from, -progress * w, 0, w, h);
      ctx.restore();
    }
    if (to) {
      ctx.save();
      ctx.beginPath(); ctx.rect((1 - progress) * w, 0, w, h); ctx.clip();
      drawCover(ctx, to, (1 - progress) * w, 0, w, h);
      ctx.restore();
    }
  },

  'builtin-slide-right': (ctx, from, to, progress, w, h) => {
    if (from) {
      ctx.save();
      ctx.beginPath(); ctx.rect(progress * w, 0, w, h); ctx.clip();
      drawCover(ctx, from, progress * w, 0, w, h);
      ctx.restore();
    }
    if (to) {
      ctx.save();
      ctx.beginPath(); ctx.rect(-(1 - progress) * w, 0, w, h); ctx.clip();
      drawCover(ctx, to, -(1 - progress) * w, 0, w, h);
      ctx.restore();
    }
  },

  // Note: sourceZoom/sourcePanX/sourcePanY params are not applied in canvas preview.
  // Canvas draw matches Remotion render for default param values (zoom=1, pan=0,0).
  'facecamtransitionbox': (ctx, from, to, progress, w, h, params) => {
    const scale    = (params.scale     as number) ?? 500;
    const xOff     = (params.xOffset   as number) ?? 350;
    const yOff     = (params.yOffset   as number) ?? 350;
    const color    = (params.wipeColor as string)  || '#c3b091';
    const boxW     = scale;
    const boxH     = scale * (9 / 16);
    const cx       = xOff;
    const cy       = h - yOff;
    const maxR     = Math.sqrt(w * w + h * h);
    const easeOut3 = (t: number) => 1 - Math.pow(1 - t, 3);
    const wipe1    = easeOut3(progress);
    const wipe2    = progress < 0.5 ? 0 : easeOut3((progress - 0.5) / 0.5);
    const r1       = wipe1 * maxR;
    const r2       = wipe2 * maxR;

    ctx.globalAlpha = 1;
    if (from) { drawCover(ctx, from, 0, 0, w, h); }

    if (r1 > 0) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r1, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    if (r2 > 0) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r2, 0, Math.PI * 2); ctx.clip();
      if (to) { drawCover(ctx, to, 0, 0, w, h); }
      ctx.save();
      ctx.beginPath(); ctx.rect(cx - boxW / 2, cy - boxH / 2, boxW, boxH); ctx.clip();
      if (from) { drawCover(ctx, from, cx - boxW / 2, cy - boxH / 2, boxW, boxH); }
      ctx.restore();
      ctx.restore();
    }
  },

  // Note: sourceZoom/sourcePanX/sourcePanY params not applied in canvas preview.
  'staticfacecam': (ctx, from, to, _progress, w, h, params) => {
    const scale = (params.scale   as number) ?? 500;
    const xOff  = (params.xOffset as number) ?? 350;
    const yOff  = (params.yOffset as number) ?? 350;
    const boxW  = scale;
    const boxH  = scale * (9 / 16);
    const cx    = xOff;
    const cy    = h - yOff;
    ctx.globalAlpha = 1;
    if (to) { drawCover(ctx, to, 0, 0, w, h); }
    ctx.save();
    ctx.beginPath(); ctx.rect(cx - boxW / 2, cy - boxH / 2, boxW, boxH); ctx.clip();
    if (from) { drawCover(ctx, from, cx - boxW / 2, cy - boxH / 2, boxW, boxH); }
    ctx.restore();
  },
};

draws['generate-a-crossfade-remotion-transition-8bcf2f'] = draws['builtin-crossfade'];

export function getCanvasDraw(transitionFileId: string): CanvasDrawFn | null {
  return draws[transitionFileId] ?? null;
}
