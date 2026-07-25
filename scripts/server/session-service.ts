import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from './http-helpers.ts';
import { cleanupSession, createSession, requireSession, saveSessionMeta, sessions } from './session-store.ts';
import { hasBlockingJob, cancelIngestJobs } from './job-store.ts';
import { evictSession } from './proxy-cache-store.ts';

// Session lifecycle endpoints: list, create, rename, delete. The store
// itself lives in session-store.ts; this is only the HTTP surface.

export function handleSessionList(req: IncomingMessage, res: ServerResponse) {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({
      sessionId: id,
      name: s.originalName,
      createdAt: s.createdAt,
      assetCount: s.assets.size,
      clipCount: s.project?.clips?.length || 0,
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  sendJSON(res, { sessions: list });
}

export async function handleSessionRename(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    const body: any = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });

    const name = (body.name || '').trim();
    if (!name) {
      sendJSON(res, { error: 'Name cannot be empty' }, 400);
      return;
    }

    session.originalName = name;
    saveSessionMeta(session);
    console.log(`[Session] Renamed ${sessionId} to "${name}"`);

    sendJSON(res, { success: true, name });
  } catch (error: any) {
    sendJSON(res, { error: error.message }, 500);
  }
}

// Create a new empty session (for multi-asset workflow)
export async function handleSessionCreate(req: IncomingMessage, res: ServerResponse) {
  try {
    const session = createSession('Untitled Project');

    console.log(`[${session.id}] Empty session created`);

    sendJSON(res, {
      success: true,
      sessionId: session.id,
      name: session.originalName,
    });

  } catch (error: any) {
    console.error('[Create] Error:', error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Delete session
export async function handleSessionDelete(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  // Don't rm the session dir while a user-initiated job is reading/writing its
  // files. Background ingest (proxy builds) don't block — we cancel them and
  // wait for their ffmpeg children to exit so the recursive rm can't EBUSY.
  if (hasBlockingJob(sessionId)) {
    sendJSON(res, {
      error: 'A job is still running for this session',
      hint: 'Wait for in-flight jobs to finish (or cancel them via DELETE /session/:id/jobs/:jobId) before deleting the session.',
    }, 409);
    return;
  }
  await cancelIngestJobs(sessionId);
  evictSession(sessionId); // drop the ramdisk warm copies before the dir goes
  cleanupSession(sessionId);
  sendJSON(res, { success: true });
}
