import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureProjectDefaults } from '../project-schema.js';
import { timelineToRemotionSpec } from '../remotion-core/timeline-to-spec.js';
import {
  normalizeSpec,
  generateAdVariants,
  parseSpecInput,
  RemotionSpecValidationError,
} from '../remotion-core/spec.js';
import { PORT } from './server-config.ts';
import { sendJSON } from './http-helpers.ts';
import { warmSession } from './proxy-cache-store.ts';
import {
  getSessionAssetsAsArray,
  requireSession,
  serializeProjectForClient,
  sessions,
  writeJsonAtomic,
  type Session,
} from './session-store.ts';
import type { SessionRoute } from './route-table.ts';

// Project state (get/save through the versioned schema) + the Remotion spec
// build/validate/variants surface. PUT project is whole-project
// last-writer-wins — R3's operation API retires it.

// Get project state
function handleProjectGet(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  // Verify the session directory still exists on disk
  if (!existsSync(session.dir)) {
    console.log(`[Session] Directory missing for ${sessionId}, cleaning up`);
    sessions.delete(sessionId);
    sendJSON(res, { error: 'Session files no longer exist' }, 404);
    return;
  }

  session.project = ensureProjectDefaults(session.project);

  // GET /project is the "user opened this session" signal — warm its proxies
  // into the ramdisk in the background (§7.1). Best-effort, never blocks the
  // response; preview falls back to the HDD proxy / source until it lands.
  warmSession(session).catch(() => {});

  sendJSON(res, serializeProjectForClient(session.project));
}

// Save project state
async function handleProjectSave(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);

    session.project = ensureProjectDefaults(session.project);

    if (data.tracks) session.project.tracks = data.tracks;
    if (data.clips) session.project.clips = data.clips;
    if (data.settings) session.project.settings = { ...session.project.settings, ...data.settings };
    if (data.captionData) session.project.captionData = data.captionData;
    if (data.brandTheme) {
      session.project.brandTheme = {
        ...session.project.brandTheme,
        ...data.brandTheme,
      };
    }
    if (data.adTemplate) session.project.adTemplate = data.adTemplate;
    if (data.transitions) session.project.transitions = data.transitions;
    if (data.timelineTransitions) session.project.timelineTransitions = data.timelineTransitions;
    if (data.renderOptions) session.project.renderOptions = data.renderOptions;

    // Save to disk for persistence
    const projectPath = join(session.dir, 'project.json');
    writeJsonAtomic(projectPath, ensureProjectDefaults(session.project), { backups: 3 });

    console.log(`[${sessionId}] Project saved: ${session.project.clips.length} clips`);

    sendJSON(res, { success: true });

  } catch (error: any) {
    sendJSON(res, { error: error.message }, 500);
  }
}

export function buildSessionRemotionSpec(session: Session, sessionId: string, options: any = {}) {
  session.project = ensureProjectDefaults(session.project);

  const spec = timelineToRemotionSpec({
    project: session.project,
    assets: getSessionAssetsAsArray(session),
    captionData: session.project.captionData || {},
    transitions: session.project.transitions || [],
    timelineTransitions: session.project.timelineTransitions || [],
    sessionId,
    baseUrl: `http://localhost:${PORT}`,
    specId: options.specId,
    title: options.title,
    brandTheme: options.brandTheme || session.project.brandTheme,
    adTemplate: options.adTemplate || session.project.adTemplate,
    defaultCaptionPreset: options.defaultCaptionPreset,
  });

  return normalizeSpec(spec);
}

export function saveSpecSnapshot(session: Session, filename: string, spec: unknown): string {
  const outputPath = join(session.rendersDir, filename);
  writeFileSync(outputPath, JSON.stringify(spec, null, 2));
  return outputPath;
}

export function parseIncomingRemotionSpec(spec: unknown, source = 'server') {
  return parseSpecInput(spec, { source });
}

export function sendSpecValidationError(res: ServerResponse, error: any): void {
  const payload = {
    error: error?.payload?.code || 'INVALID_REMOTION_SPEC',
    message: error.message,
    details: Array.isArray(error.issues) ? error.issues : [],
  };

  sendJSON(res, payload, 422);
}

async function handleGetRemotionSpec(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    const spec = buildSessionRemotionSpec(session, sessionId);
    const specPath = saveSpecSnapshot(session, `spec-${Date.now()}.json`, spec);

    sendJSON(res, {
      success: true,
      spec,
      specPath,
    });
  } catch (error: any) {
    if (error instanceof RemotionSpecValidationError) {
      sendSpecValidationError(res, error);
      return;
    }

    console.error(`[${sessionId}] Failed to build remotion spec:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

async function handleGenerateRemotionVariants(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};

    const specResult = options.baseSpec
      ? parseIncomingRemotionSpec(options.baseSpec, `api:/session/${sessionId}/remotion-spec/variants`)
      : {
        spec: buildSessionRemotionSpec(session, sessionId, {
          defaultCaptionPreset: options.defaultCaptionPreset,
        }),
        migration: { migrated: false, fromVersion: '2.0', toVersion: '2.0' },
        warnings: [],
      };

    const variants = generateAdVariants(specResult.spec, {
      count: options.count || 3,
      hooks: options.hooks,
      hookPool: options.hookPool,
      bodies: options.bodies,
      bodyPool: options.bodyPool,
      ctas: options.ctas,
      ctaPool: options.ctaPool,
      toneProfile: options.toneProfile,
      captionStyleProfile: options.captionStyleProfile,
    });

    const variantPaths = variants.map((variant: unknown, index: number) => {
      const filename = `variant-spec-${String(index + 1).padStart(2, '0')}-${Date.now()}.json`;
      return saveSpecSnapshot(session, filename, variant);
    });

    sendJSON(res, {
      success: true,
      count: variants.length,
      variants,
      variantPaths,
      migration: specResult.migration,
      warnings: specResult.warnings,
    });
  } catch (error: any) {
    if (error instanceof RemotionSpecValidationError) {
      sendSpecValidationError(res, error);
      return;
    }

    console.error(`[${sessionId}] Variant generation failed:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

export const projectRoutes: SessionRoute[] = [
  { method: 'GET', action: 'project', handler: handleProjectGet },
  { method: 'PUT', action: 'project', handler: handleProjectSave },
  { method: 'GET', action: 'remotion-spec', handler: handleGetRemotionSpec },
  { method: 'POST', action: 'remotion-spec/variants', handler: handleGenerateRemotionVariants },
];
