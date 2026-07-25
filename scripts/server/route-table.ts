import type { IncomingMessage, ServerResponse } from 'http';

// Uniform route-table contract every service exports. The entry file matches
// these BEFORE its legacy dispatch chain; once every route lives in a table,
// the final Phase-2 slice swaps the matcher for the Hono layer without
// touching any service. `action` is the exact path segment after
// /session/:id/ (query string excluded).

export type SessionRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  url: URL,
) => void | Promise<void>;

export interface SessionRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  action: string;
  handler: SessionRouteHandler;
}

export function matchSessionRoute(
  routes: SessionRoute[],
  method: string | undefined,
  action: string,
): SessionRoute | undefined {
  return routes.find(r => r.method === method && r.action === action);
}
