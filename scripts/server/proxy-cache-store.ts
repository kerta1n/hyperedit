import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { copyFile } from 'fs/promises';
import { join } from 'path';
import { TEMP_DIR } from './server-config.ts';
import type { Session } from './session-store.ts';
import { planEviction, type EvictionCandidate } from './proxy-eviction-helpers.ts';

// Ramdisk warm-copy cache for preview proxies (Phase 5 §7.1). The canonical
// proxy lives on the HDD (sessions/{id}/proxies); on session open the active
// session's proxies are copied here so preview seeks are fast, and the ramdisk
// is kept within a byte budget by evicting OTHER sessions whole, least-recently-
// used first. Preview serving (step 6) reads the warm copy; this module only
// manages its presence. A restart starts with an empty in-memory map, so the
// on-disk warm dir is cleared at startup and re-warmed lazily from the HDD —
// proxies are never regenerated here. Container mapping: ramdisk → tmpfs, same path.

const WARM_ROOT = join(TEMP_DIR, 'proxies');
// Don't evict a session whose proxies were streamed/opened within this window.
const STREAM_GUARD_MS = 5 * 60 * 1000;

function budgetBytes(): number {
  const mb = Number(process.env.HYPEREDIT_RAMDISK_BUDGET_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 2800) * 1024 * 1024;
}

interface WarmEntry { sizeBytes: number; lastAccess: number; }
const warm = new Map<string, WarmEntry>();

const asMB = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

// Clear stale warm dirs from a previous run — the in-memory map is empty after
// a restart, so anything on disk is untracked budget. Sessions re-warm on open.
// Called once at startup.
export function resetWarmCache(): void {
  try {
    if (existsSync(WARM_ROOT)) rmSync(WARM_ROOT, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[ProxyCache] Could not clear warm root: ${(e as Error).message}`);
  }
  warm.clear();
}

// Return the warm (ramdisk) proxy path for an asset if the file exists, else
// null. Step-6 stream tier resolution (§7.4) consumes this first, ahead of the
// HDD proxy and the source. Does not bump last-access — the stream handler
// calls touch(sessionId) separately for every stream, proxy or not.
export function getWarmProxyPath(sessionId: string, assetId: string): string | null {
  const file = join(WARM_ROOT, sessionId, `${assetId}.mp4`);
  return existsSync(file) ? file : null;
}

// Bump last-access for an already-warm session (called when its media streams).
// No-op for un-warmed sessions.
export function touch(sessionId: string): void {
  const e = warm.get(sessionId);
  if (e) e.lastAccess = Date.now();
}

// Drop a whole session's warm copies (session delete or LRU eviction).
export function evictSession(sessionId: string): void {
  const dest = join(WARM_ROOT, sessionId);
  try {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[ProxyCache] Evict failed for ${sessionId}: ${(e as Error).message}`);
  }
  if (warm.delete(sessionId)) console.log(`[ProxyCache] Evicted warm proxies for ${sessionId}`);
}

// Drop one asset's warm proxy copy (asset delete, or before a rebuilt proxy
// supersedes it — §7.6 "invalidation hits BOTH tiers": the resolution order
// makes a stale ramdisk copy win over the fresh HDD one). Keeps the session's
// tracked size honest.
export function evictAssetProxy(sessionId: string, assetId: string): void {
  const file = join(WARM_ROOT, sessionId, `${assetId}.mp4`);
  if (!existsSync(file)) return;
  let removed = 0;
  try {
    removed = statSync(file).size;
    rmSync(file, { force: true });
  } catch {
    return;
  }
  const e = warm.get(sessionId);
  if (e) e.sizeBytes = Math.max(0, e.sizeBytes - removed);
}

// Warm the active session's HDD proxies into the ramdisk, evicting other
// sessions LRU to stay within budget. Idempotent, async (large copies must not
// block the event loop), best-effort — a failed copy or an over-budget session
// just skips, and preview falls back to the HDD proxy / source.
export async function warmSession(session: Session): Promise<void> {
  const src = join(session.dir, 'proxies');
  if (!existsSync(src)) return;
  // Only warm proxies the asset marks `ready`. A proxy mid-encode (fresh upload)
  // or mid-rebuild (dead-air `building`) is a partial file on disk — copying it
  // to the warm tier would serve garbage once status flips ready. This invariant
  // (never warm a not-ready proxy) is why the ingest lane needs NO per-build warm
  // eviction: onAssetMutated drops the warm copy on mutation, and warming simply
  // won't recreate it until the rebuild sets ready again.
  const files = readdirSync(src).filter(
    (f) => f.endsWith('.mp4') && session.assets.get(f.slice(0, -4))?.proxy?.status === 'ready',
  );
  if (files.length === 0) return;

  let incomingBytes = 0;
  for (const f of files) {
    try { incomingBytes += statSync(join(src, f)).size; } catch { /* skip unreadable */ }
  }

  const dest = join(WARM_ROOT, session.id);
  if (warm.has(session.id) && files.every((f) => existsSync(join(dest, f)))) {
    touch(session.id);
    return;
  }

  const current: EvictionCandidate[] = [];
  for (const [sid, e] of warm) {
    if (sid !== session.id) current.push({ sessionId: sid, sizeBytes: e.sizeBytes, lastAccess: e.lastAccess });
  }
  const plan = planEviction(current, incomingBytes, budgetBytes(), { now: Date.now(), guardMs: STREAM_GUARD_MS });
  for (const sid of plan.evict) evictSession(sid);
  if (!plan.fits) {
    console.warn(`[ProxyCache] ${session.id} proxies (${asMB(incomingBytes)}) exceed the ramdisk budget even after eviction — not warmed`);
    return;
  }

  try {
    mkdirSync(dest, { recursive: true });
    for (const f of files) {
      await copyFile(join(src, f), join(dest, f));
    }
    warm.set(session.id, { sizeBytes: incomingBytes, lastAccess: Date.now() });
    console.log(`[ProxyCache] Warmed ${files.length} prox${files.length === 1 ? 'y' : 'ies'} (${asMB(incomingBytes)}) for ${session.id}`);
  } catch (e) {
    console.warn(`[ProxyCache] Warm failed for ${session.id}: ${(e as Error).message}`);
    evictSession(session.id); // leave no half-copied dir claiming budget
  }
}
