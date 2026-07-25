import type { IncomingMessage, ServerResponse } from 'http';
import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { getAccelSummary } from '../hwaccel-config.js';
import { sendJSON } from './http-helpers.ts';
import { sessions } from './session-store.ts';
import { matchSessionRoute, type SessionRoute } from './route-table.ts';
import { giphyRoutes } from './giphy-service.ts';
import { transitionRoutes } from './transition-service.ts';
import { deadAirRoutes } from './dead-air-service.ts';
import { transcriptionRoutes } from './transcription-service.ts';
import { projectRoutes } from './project-service.ts';
import {
  handleDeleteRender,
  handleRenameRender,
  handleRenderDownload,
  handleRenderFileDownload,
  handleRenderThumbnail,
  RENDER_FILE_RE,
  RENDER_STEM_RE,
  renderRoutes,
} from './render-service.ts';
import { assetRoutes, handleAssetDelete, handleAssetStream, handleAssetThumbnail } from './asset-service.ts';
import { assetProcessingRoutes } from './asset-processing-service.ts';
import { brollRoutes } from './broll-service.ts';
import { animationGenerateRoutes } from './animation-generate-service.ts';
import { animationEditRoutes } from './animation-edit-service.ts';
import { animationConceptRoutes } from './animation-concept-service.ts';
import { animationContentRoutes } from './animation-content-service.ts';
import { imageGenRoutes } from './image-gen-service.ts';
import { videoGenRoutes } from './video-gen-service.ts';
import { handleAiEditCommand } from './director-service.ts';
import { handleSessionCreate, handleSessionDelete, handleSessionList, handleSessionRename } from './session-service.ts';
import { handleJobCancel, handleJobStatus } from './job-service.ts';
import { serveSpa } from './spa-helpers.ts';

// The thin HTTP layer: Hono routing over the raw-(req,res) service handlers.
// Handlers write directly to the Node response (streams, NDJSON, range
// requests), so every route delegates and returns RESPONSE_ALREADY_SENT.
// Behavior is byte-compatible with the retired regex dispatcher.

type Env = { Bindings: HttpBindings };

const SESSION_ROUTES: SessionRoute[] = [
  ...giphyRoutes,
  ...transitionRoutes,
  ...deadAirRoutes,
  ...transcriptionRoutes,
  ...projectRoutes,
  ...renderRoutes,
  ...assetRoutes,
  ...assetProcessingRoutes,
  ...brollRoutes,
  ...animationGenerateRoutes,
  ...animationEditRoutes,
  ...animationConceptRoutes,
  ...animationContentRoutes,
  ...imageGenRoutes,
  ...videoGenRoutes,
];

export function buildApp() {
  const app = new Hono<Env>();

  // CORS on every response + OPTIONS preflight, applied to the raw response
  // BEFORE handlers write heads (matches the old top-of-dispatch behavior).
  app.use('*', async (c, next) => {
    const res = c.env.outgoing;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    if (c.req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return RESPONSE_ALREADY_SENT;
    }
    await next();
  });

  const raw = (fn: (req: IncomingMessage, res: ServerResponse) => unknown) =>
    async (c: any) => {
      await fn(c.env.incoming, c.env.outgoing);
      return RESPONSE_ALREADY_SENT;
    };

  // Service route tables: /session/:sessionId/<action>
  for (const route of SESSION_ROUTES) {
    app.on(route.method, `/session/:sessionId/${route.action}`, async (c) => {
      await route.handler(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), new URL(c.req.url));
      return RESPONSE_ALREADY_SENT;
    });
  }

  // Session lifecycle (static /session/create wins over :sessionId)
  app.post('/session/create', raw(handleSessionCreate));
  app.delete('/session/:sessionId', async (c) => {
    handleSessionDelete(c.env.incoming, c.env.outgoing, c.req.param('sessionId'));
    return RESPONSE_ALREADY_SENT;
  });
  app.patch('/session/:sessionId/name', async (c) => {
    await handleSessionRename(c.env.incoming, c.env.outgoing, c.req.param('sessionId'));
    return RESPONSE_ALREADY_SENT;
  });

  // Parameterized asset routes
  app.delete('/session/:sessionId/assets/:assetId', async (c) => {
    handleAssetDelete(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), c.req.param('assetId'));
    return RESPONSE_ALREADY_SENT;
  });
  app.get('/session/:sessionId/assets/:assetId/thumbnail', async (c) => {
    await handleAssetThumbnail(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), c.req.param('assetId'));
    return RESPONSE_ALREADY_SENT;
  });
  app.get('/session/:sessionId/assets/:assetId/stream', async (c) => {
    await handleAssetStream(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), c.req.param('assetId'));
    return RESPONSE_ALREADY_SENT;
  });
  app.all('/session/:sessionId/assets/*', async (c) => {
    sendJSON(c.env.outgoing, { error: 'Asset endpoint not found' }, 404);
    return RESPONSE_ALREADY_SENT;
  });

  // Render management (GET /renders list is table-routed; guard other methods)
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/session/:sessionId/renders', async (c) => {
    sendJSON(c.env.outgoing, { error: 'Method not allowed' }, 405);
    return RESPONSE_ALREADY_SENT;
  });
  app.get('/session/:sessionId/renders/:stem/thumbnail', async (c) => {
    const stem = c.req.param('stem');
    if (!RENDER_STEM_RE.test(stem)) {
      sendJSON(c.env.outgoing, { error: 'Invalid render ID' }, 400);
    } else {
      await handleRenderThumbnail(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), stem);
    }
    return RESPONSE_ALREADY_SENT;
  });
  app.get('/session/:sessionId/renders/:file/download', async (c) => {
    const file = c.req.param('file');
    if (!RENDER_FILE_RE.test(file)) {
      sendJSON(c.env.outgoing, { error: 'Invalid filename' }, 400);
    } else {
      await handleRenderFileDownload(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), file);
    }
    return RESPONSE_ALREADY_SENT;
  });
  app.patch('/session/:sessionId/renders/:stem/name', async (c) => {
    const stem = c.req.param('stem');
    if (!RENDER_STEM_RE.test(stem)) {
      sendJSON(c.env.outgoing, { error: 'Invalid render ID' }, 400);
    } else {
      await handleRenameRender(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), stem);
    }
    return RESPONSE_ALREADY_SENT;
  });
  app.delete('/session/:sessionId/renders/:stem', async (c) => {
    const stem = c.req.param('stem');
    if (!RENDER_STEM_RE.test(stem)) {
      sendJSON(c.env.outgoing, { error: 'Invalid render ID' }, 400);
    } else {
      await handleDeleteRender(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), stem);
    }
    return RESPONSE_ALREADY_SENT;
  });
  // Legacy preview/export download (GET /renders/:stemOrType)
  app.get('/session/:sessionId/renders/:stem', async (c) => {
    await handleRenderDownload(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), c.req.param('stem'));
    return RESPONSE_ALREADY_SENT;
  });
  app.all('/session/:sessionId/renders/*', async (c) => {
    sendJSON(c.env.outgoing, { error: 'Render endpoint not found' }, 404);
    return RESPONSE_ALREADY_SENT;
  });

  // Job status/cancel (Phase-3 job model: long-running routes answer
  // 202 { jobId }; state is polled here, DELETE cancels).
  app.get('/session/:sessionId/jobs/:jobId', async (c) => {
    await handleJobStatus(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), c.req.param('jobId'));
    return RESPONSE_ALREADY_SENT;
  });
  app.delete('/session/:sessionId/jobs/:jobId', async (c) => {
    await handleJobCancel(c.env.incoming, c.env.outgoing, c.req.param('sessionId'), c.req.param('jobId'));
    return RESPONSE_ALREADY_SENT;
  });
  app.all('/session/:sessionId/jobs/*', async (c) => {
    sendJSON(c.env.outgoing, { error: 'Job endpoint not found' }, 404);
    return RESPONSE_ALREADY_SENT;
  });

  // Anything else under /session/:id is a 404, never the SPA fallback
  // (matches the retired dispatcher's session-scope behavior).
  app.all('/session/:sessionId/*', async (c) => {
    sendJSON(c.env.outgoing, { error: 'Session endpoint not found' }, 404);
    return RESPONSE_ALREADY_SENT;
  });
  app.all('/session/:sessionId', async (c) => {
    sendJSON(c.env.outgoing, { error: 'Session endpoint not found' }, 404);
    return RESPONSE_ALREADY_SENT;
  });

  // Top-level routes
  app.get('/sessions', raw(handleSessionList));
  app.post('/ai-edit', raw(handleAiEditCommand));
  app.get('/hwaccel-info', async (c) => {
    const res = c.env.outgoing;
    let info;
    try {
      info = getAccelSummary();
    } catch {
      info = { error: 'Hardware detection has not completed yet. Try again shortly.' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(info, null, 2));
    return RESPONSE_ALREADY_SENT;
  });
  app.get('/health', async (c) => {
    sendJSON(c.env.outgoing, { status: 'ok', ffmpeg: 'native', sessions: sessions.size });
    return RESPONSE_ALREADY_SENT;
  });

  // Anything unmatched: GET serves the built SPA, other methods 404
  app.notFound(async (c) => {
    if (c.req.method === 'GET') {
      serveSpa(c.env.outgoing, new URL(c.req.url).pathname);
    } else {
      sendJSON(c.env.outgoing, { error: 'Not found' }, 404);
    }
    return RESPONSE_ALREADY_SENT as any;
  });

  return app;
}

// Kept exported for tests/tooling that want to inspect the flat route table.
export { SESSION_ROUTES, matchSessionRoute };
