import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from './http-helpers.ts';
import { cleanupSession, createSession, requireSession, saveSessionMeta, sessions } from './session-store.ts';

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
export function handleSessionDelete(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  cleanupSession(sessionId);
  sendJSON(res, { success: true });
}
