import type { ServerResponse } from 'http';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createDefaultProjectState, ensureProjectDefaults } from '../project-schema.js';
import { SESSIONS_DIR, TEMP_DIR, UPLOAD_STAGING_DIR } from './server-config.ts';
import { sendJSON } from './http-helpers.ts';

export interface SessionAsset {
  id: string;
  type: string;
  filename: string;
  path: string;
  thumbPath?: string | null;
  size?: number;
  createdAt?: number;
  aiGenerated?: boolean;
  description?: string;
  sceneCount?: number;
  sceneDataPath?: string;
  editCount?: number;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  // Ingest conform flags (source media properties, additive since Phase 5)
  vfr?: boolean;
  hdr?: boolean;
  rotation?: number;
  [key: string]: any;
}

export interface Session {
  id: string;
  dir: string;
  assetsDir: string;
  rendersDir: string;
  originalName: string;
  createdAt: number;
  editCount: number;
  assets: Map<string, SessionAsset>;
  project: any;
  transcriptCache: Map<string, any>;
  [key: string]: any;
}

// Active video sessions - keeps videos on disk between edits
export const sessions = new Map<string, Session>();

// Look up a session, sending the standard 404 when missing. Callers bail with
// `if (!session) return;`.
export function requireSession(res: ServerResponse, sessionId: string): Session | undefined {
  const session = getSession(sessionId);
  if (!session) sendJSON(res, { error: 'Session not found' }, 404);
  return session;
}

// Clean up stale 0kb temp files that Formidable or ffmpeg might leave behind
export function cleanupStaleTempFiles(): void {
  const sweep = (dir: string) => {
    try {
      const files = readdirSync(dir);
      let count = 0;
      const now = Date.now();
      for (const file of files) {
        if (file === 'sessions') continue;
        const fullPath = join(dir, file);
        const stats = statSync(fullPath);
        // Delete files that are 0KB or older than 12 hours
        if (stats.isFile() && (stats.size === 0 || now - stats.mtimeMs > 12 * 60 * 60 * 1000)) {
          unlinkSync(fullPath);
          count++;
        }
      }
      if (count > 0) console.log(`[Cleanup] Removed ${count} stale temp files from ${dir}`);
    } catch (err) {
      console.warn(`[Cleanup] Error cleaning ${dir}:`, (err as Error).message);
    }
  };
  sweep(TEMP_DIR);
  sweep(UPLOAD_STAGING_DIR);
}

// Restore sessions from disk on server start
export function restoreSessionsFromDisk(): void {
  console.log('[Server] Restoring sessions from disk...');
  const sessionDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
    .map(dirent => dirent.name);

  for (const sessionId of sessionDirs) {
    const sessionDir = join(SESSIONS_DIR, sessionId);
    const assetsDir = join(sessionDir, 'assets');
    const rendersDir = join(sessionDir, 'renders');

    // Skip if assets directory doesn't exist
    if (!existsSync(assetsDir)) {
      console.log(`[Session] Skipping ${sessionId} - no assets directory`);
      continue;
    }

    // Restore project state from disk if it exists
    const projectPath = join(sessionDir, 'project.json');
    let projectState = createDefaultProjectState();

    if (existsSync(projectPath)) {
      try {
        projectState = ensureProjectDefaults(JSON.parse(readFileSync(projectPath, 'utf-8')));
      } catch (e) {
        console.log(`[Session] Could not read project.json for ${sessionId}, trying backups`);
        for (let i = 1; i <= 3; i++) {
          const bakPath = `${projectPath}.bak${i}`;
          if (!existsSync(bakPath)) continue;
          try {
            projectState = ensureProjectDefaults(JSON.parse(readFileSync(bakPath, 'utf-8')));
            console.log(`[Session] Recovered project.json for ${sessionId} from .bak${i}`);
            break;
          } catch { }
        }
      }
    }

    // Restore assets from disk
    const assets = new Map<string, SessionAsset>();

    // Try to load saved asset metadata first
    const assetsMetaPath = join(sessionDir, 'assets-meta.json');
    let savedAssetsMeta: Record<string, any> = {};
    if (existsSync(assetsMetaPath)) {
      try {
        savedAssetsMeta = JSON.parse(readFileSync(assetsMetaPath, 'utf-8'));
        console.log(`[Session] Found saved metadata for ${Object.keys(savedAssetsMeta).length} assets`);
      } catch (e) {
        console.error(`[Session] CORRUPT assets-meta.json for ${sessionId} (${(e as Error).message}) — asset metadata (fps/aiGenerated/duration) at risk, trying backups`);
        for (let i = 1; i <= 3; i++) {
          try {
            savedAssetsMeta = JSON.parse(readFileSync(`${assetsMetaPath}.bak${i}`, 'utf-8'));
            console.error(`[Session] Recovered asset metadata from assets-meta.json.bak${i} for ${sessionId}`);
            break;
          } catch { /* try next backup */ }
        }
        if (Object.keys(savedAssetsMeta).length === 0) {
          console.error(`[Session] No usable backup — session ${sessionId} restores WITHOUT asset metadata`);
        }
      }
    }

    const assetFiles = readdirSync(assetsDir, { withFileTypes: true })
      .filter(dirent => dirent.isFile() && !dirent.name.includes('_thumb'));

    for (const assetFile of assetFiles) {
      const assetPath = join(assetsDir, assetFile.name);
      const assetId = assetFile.name.replace(/\.[^/.]+$/, ''); // Remove extension
      const ext = assetFile.name.split('.').pop()!.toLowerCase();

      // Determine asset type from extension
      let type = 'video';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        type = 'image';
      } else if (['mp3', 'wav', 'aac', 'm4a'].includes(ext)) {
        type = 'audio';
      }

      try {
        const stats = statSync(assetPath);
        const thumbPath = join(assetsDir, `${assetId}_thumb.jpg`);

        // Merge with saved metadata if available
        const savedMeta = savedAssetsMeta[assetId] || {};

        assets.set(assetId, {
          id: assetId,
          type: savedMeta.type || type,
          filename: savedMeta.filename || assetFile.name,
          path: assetPath,
          thumbPath: existsSync(thumbPath) ? thumbPath : null,
          size: stats.size,
          createdAt: savedMeta.createdAt || stats.mtimeMs,
          // Restore AI-generated metadata
          aiGenerated: savedMeta.aiGenerated || false,
          description: savedMeta.description,
          sceneCount: savedMeta.sceneCount,
          sceneDataPath: savedMeta.sceneDataPath,
          editCount: savedMeta.editCount || 0,
          duration: savedMeta.duration,
          width: savedMeta.width,
          height: savedMeta.height,
          fps: savedMeta.fps,
          // Additive since Phase 5; absent on pre-Phase-5 assets (backfilled on re-ingest)
          vfr: savedMeta.vfr,
          hdr: savedMeta.hdr,
          rotation: savedMeta.rotation,
        });

        if (savedMeta.aiGenerated) {
          console.log(`[Session] Restored AI-generated asset: ${assetFile.name}`);
        }
      } catch (e) {
        console.log(`[Session] Could not stat asset ${assetFile.name}`);
      }
    }

    // Load session-meta.json if present (persists name + createdAt)
    const sessionMetaPath = join(sessionDir, 'session-meta.json');
    let sessionMeta: { name?: string; createdAt?: number } | null = null;
    if (existsSync(sessionMetaPath)) {
      try {
        sessionMeta = JSON.parse(readFileSync(sessionMetaPath, 'utf-8'));
      } catch (e) {
        console.log(`[Session] Could not read session-meta.json for ${sessionId}`);
      }
    }

    // Skip sessions with no assets AND no meta (truly abandoned dirs)
    if (assets.size === 0 && !sessionMeta) {
      console.log(`[Session] Skipping ${sessionId} - no assets and no meta`);
      continue;
    }

    const session: Session = {
      id: sessionId,
      dir: sessionDir,
      assetsDir,
      rendersDir,
      originalName: sessionMeta?.name || 'Restored Project',
      createdAt: sessionMeta?.createdAt || Date.now(),
      editCount: 0,
      assets,
      project: projectState,
      transcriptCache: new Map(),
    };

    sessions.set(sessionId, session);
    console.log(`[Session] Restored: ${sessionId} (${assets.size} assets)`);
  }

  console.log(`[Server] Restored ${sessions.size} sessions from disk`);
}

// Atomic JSON write for all session-state JSON: write to a temp file, then rename
// over the target — a crash or power loss mid-write can never corrupt the only
// copy. `backups` keeps rolling copies of the previous contents
// (.bak1 newest → .bakN oldest) for files representing hours of editing work.
export function writeJsonAtomic(filePath: string, data: unknown, { backups = 0 }: { backups?: number } = {}): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  if (backups > 0 && existsSync(filePath)) {
    for (let i = backups - 1; i >= 1; i--) {
      const older = `${filePath}.bak${i}`;
      if (existsSync(older)) {
        try { renameSync(older, `${filePath}.bak${i + 1}`); } catch { }
      }
    }
    try { copyFileSync(filePath, `${filePath}.bak1`); } catch { }
  }
  renameSync(tmpPath, filePath);
}

// Save asset metadata to disk (preserves aiGenerated flag, etc.)
export function saveAssetMetadata(session: Session): void {
  if (!session || !session.dir) return;

  const assetsMetaPath = join(session.dir, 'assets-meta.json');
  const metadata: Record<string, any> = {};

  for (const [assetId, asset] of session.assets) {
    // Only save metadata that needs to persist (not paths which are reconstructed)
    metadata[assetId] = {
      type: asset.type,
      filename: asset.filename,
      createdAt: asset.createdAt,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      // AI-generated specific metadata
      aiGenerated: asset.aiGenerated || false,
      description: asset.description,
      sceneCount: asset.sceneCount,
      sceneDataPath: asset.sceneDataPath,
      editCount: asset.editCount || 0,
      // fps the animation was rendered at — scene frame counts are anchored to
      // it, so edits must re-render at this fps to preserve wall-clock length
      fps: asset.fps,
      // Ingest conform flags (additive since Phase 5)
      vfr: asset.vfr,
      hdr: asset.hdr,
      rotation: asset.rotation,
    };
  }

  try {
    writeJsonAtomic(assetsMetaPath, metadata, { backups: 3 });
  } catch (e) {
    console.log(`[Session] Could not save assets metadata: ${(e as Error).message}`);
  }
}

// Asset-mutation choke point (Phase 5 §7.5). A destructive in-place edit
// rewrites an asset's bytes under the SAME asset id, staling everything keyed to
// it. This owns the cheap in-memory invalidation; the caller re-enqueues an
// ingest job (enqueueIngest) to rebuild the derived artifacts — the thumbnail,
// and later the proxy + waveform peaks. Kept split so session-store stays free
// of a job-queue/ingest import (no cycle).
//   - invalidate the cached transcript (word timings shifted with the cut)
//   - persist metadata — dead-air updates duration/size in memory only, so a
//     restart would otherwise restore the PRE-edit values from assets-meta.json
// Dead-air is currently the only in-place rewrite path (process-asset and
// extract-audio produce NEW assets). R9 immutable versions supersede this.
export function onAssetMutated(session: Session, assetId: string): void {
  if (!session) return;
  session.transcriptCache?.delete(assetId);
  saveAssetMetadata(session);
}

// Composition values (fps/width/height) are owned by the project's settings
// (spec.settings source of truth). Request-body values remain honored as an
// explicit override for API callers, but the UI no longer sends them.
export function resolveCompositionSettings(session: Session, body: any = {}): { fps: number; width: number; height: number } {
  const settings = ensureProjectDefaults(session.project).settings;
  return {
    fps: body.fps || settings.fps,
    width: body.width || settings.width,
    height: body.height || settings.height,
  };
}

export function orientationOf(width: number, height: number): 'square' | 'landscape' | 'portrait' {
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

export function serializeProjectForClient(project: any = {}) {
  const normalized = ensureProjectDefaults(project);
  return {
    version: normalized.version,
    tracks: normalized.tracks,
    clips: normalized.clips,
    settings: normalized.settings,
    captionData: normalized.captionData,
    transitions: normalized.transitions || [],
    timelineTransitions: normalized.timelineTransitions || [],
    brandTheme: normalized.brandTheme,
    adTemplate: normalized.adTemplate,
    renderOptions: normalized.renderOptions || null,
  };
}

export function getSessionAssetsAsArray(session: Session) {
  return Array.from(session.assets.values()).map((asset) => ({
    ...asset,
    publicPath: `/session/${session.id}/assets/${asset.id}/stream`,
  }));
}

// Session meta persistence (name + createdAt survive restarts)
export function saveSessionMeta(session: Session): void {
  try {
    const metaPath = join(session.dir, 'session-meta.json');
    writeJsonAtomic(metaPath, {
      name: session.originalName,
      createdAt: session.createdAt,
    });
  } catch (e) {
    console.log(`[Session] Could not save session-meta.json: ${(e as Error).message}`);
  }
}

// Session management
export function createSession(originalName: string): Session {
  const sessionId = randomUUID();
  const sessionDir = join(SESSIONS_DIR, sessionId);
  const assetsDir = join(sessionDir, 'assets');
  const rendersDir = join(sessionDir, 'renders');

  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(rendersDir, { recursive: true });

  // Initialize project state with Remotion-first defaults
  const projectState = createDefaultProjectState();

  const session: Session = {
    id: sessionId,
    dir: sessionDir,
    assetsDir,
    rendersDir,
    originalName,
    createdAt: Date.now(),
    editCount: 0,
    assets: new Map(), // assetId -> asset info
    project: projectState,
    transcriptCache: new Map(), // assetId -> { text, words, cachedAt }
  };
  sessions.set(sessionId, session);
  saveSessionMeta(session);
  console.log(`[Session] Created: ${sessionId}`);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function cleanupSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    try {
      rmSync(session.dir, { recursive: true, force: true });
      sessions.delete(sessionId);
      console.log(`[Session] Cleaned up: ${sessionId}`);
    } catch (e) {
      console.error(`[Session] Cleanup error for ${sessionId}:`, (e as Error).message);
    }
  }
}
