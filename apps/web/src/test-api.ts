import { vi } from 'vitest';

type Answer = { status?: number; json?: unknown };
type Route = ((body: unknown) => Answer | Promise<Answer>) | object;

/**
 * Answers fetch from a table of "METHOD /path" routes, as the server would; a call to any
 * other route fails the test. Returns the calls made, with their parsed bodies.
 */
export function mockApi(answers: Record<string, Route>) {
  // The shell always asks for the person's computers and agents; a test that cares says otherwise.
  const routes: Record<string, Route> = {
    'GET /api/seats': [],
    'GET /api/agents': { agents: [] },
    'GET /api/approvals': { approvals: [] },
    'GET /api/tasks/folders': { folders: [] },
    'GET /api/tasks?status=open&limit=100': { tasks: [], nextBefore: null },
    'GET /api/tasks?status=review&limit=20': { tasks: [], nextBefore: null },
    ...answers,
  };
  const calls: { route: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const route = `${init?.method ?? 'GET'} ${path}`;
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ route, body });
      const handler = routes[route];
      if (!handler) throw new Error(`Unexpected call: ${route}`);
      const reply = typeof handler === 'function' ? await handler(body) : { json: handler };
      // Status 0 stands for a server that cannot be reached.
      if (reply.status === 0) throw new TypeError('Failed to fetch');
      return new Response(reply.status === 204 ? null : JSON.stringify(reply.json ?? {}), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

/** An answer with a status other than 200. */
export const answer = (status: number, json?: unknown) => () => ({ status, json });

/** The server's error answer. */
export const failure =
  (status: number, code: string, message = `Server says ${code}`, details?: unknown) =>
  () => ({ status, json: { error: { code, message, details } } });

export const admin = { id: 'u1', name: 'Ann Admin', email: 'ann@acme.com', role: 'admin' };
export const member = { id: 'u2', name: 'Bob Member', email: 'bob@acme.com', role: 'member' };
