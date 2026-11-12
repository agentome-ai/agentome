import { request } from 'node:http';
import type { Duplex } from 'node:stream';
import { deriveKey } from '../auth.js';
import { AppError } from '../errors.js';
import type { ServiceSpec } from '../projects/devcontainer.js';
import { type PlaceState, SIGNATURE_HEADER, signOrder, TIME_HEADER } from './protocol.js';

// The server's side of the place launcher: each order signed with the key both derive from the
// installation's secret.

export const LAUNCHER_PURPOSE = 'place-launcher';

export type Launcher = ReturnType<typeof placeLauncher>;

export function placeLauncher(url: string, secretKey: string, fetchImpl: typeof fetch = fetch) {
  const key = deriveKey(secretKey, LAUNCHER_PURPOSE);
  async function order(method: string, path: string, body?: unknown, timeoutMs = 180_000) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const time = String(Date.now());
    let answer: Response;
    try {
      answer = await fetchImpl(`${url}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          [TIME_HEADER]: time,
          [SIGNATURE_HEADER]: signOrder(key, method, path, time, text),
        },
        ...(text && { body: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new AppError(
        'place_unavailable',
        `The place launcher did not answer: ${String(error)}`,
      );
    }
    const said = (await answer.json().catch(() => undefined)) as
      { state?: PlaceState; startedAt?: string; terminals?: number; error?: string } | undefined;
    if (!answer.ok) {
      const message = said?.error ?? `The place launcher answered ${answer.status}`;
      throw new AppError(answer.status === 409 ? 'place_exists' : 'place_unavailable', message);
    }
    return said;
  }
  return {
    state: async (id: string) => (await order('GET', `/places/${id}`))?.state ?? 'none',
    /** The state, and since when an awake place has been awake. */
    status: async (id: string) => {
      const said = await order('GET', `/places/${id}`);
      return {
        state: said?.state ?? 'none',
        startedAt: said?.startedAt,
        terminals: said?.terminals ?? 0,
      };
    },
    create: async (id: string, code: string) =>
      void (await order('POST', `/places/${id}`, { code })),
    wake: async (id: string) => void (await order('POST', `/places/${id}/wake`)),
    sleep: async (id: string) => void (await order('POST', `/places/${id}/sleep`)),
    remove: async (id: string) => void (await order('DELETE', `/places/${id}`)),
    /** Empties an agent's working folders in the person's place. */
    freshFolders: async (id: string, agentId: string) =>
      void (await order('DELETE', `/places/${id}/folders/${agentId}`)),
    /**
     * Runs a project's services beside the agent, and stops those of any other project. Pulling
     * their images may take minutes.
     */
    services: async (
      id: string,
      shape: { project: string; hash: string; services: ServiceSpec[] },
    ) => void (await order('PUT', `/places/${id}/services`, shape, 15 * 60_000)),
    resize: async (id: string, cols: number, rows: number) =>
      void (await order('POST', `/places/${id}/resize`, { cols, rows })),
    /** A terminal in the person's place: the launcher's stream, both ways. */
    terminal: (id: string) =>
      new Promise<Duplex>((resolve, reject) => {
        const path = `/places/${id}/terminal`;
        const time = String(Date.now());
        const call = request(`${url}${path}`, {
          method: 'GET',
          headers: {
            connection: 'Upgrade',
            upgrade: 'tcp',
            [TIME_HEADER]: time,
            [SIGNATURE_HEADER]: signOrder(key, 'GET', path, time, ''),
          },
        });
        call.on('upgrade', (_answer, socket, head) => {
          if (head.length > 0) socket.unshift(head);
          resolve(socket);
        });
        call.on('response', (answer) => {
          answer.resume();
          reject(
            new AppError(
              'place_unavailable',
              `The place launcher opened no terminal: ${answer.statusMessage ?? answer.statusCode}`,
            ),
          );
        });
        call.on('error', (error) =>
          reject(
            new AppError(
              'place_unavailable',
              `The place launcher did not answer: ${error.message}`,
            ),
          ),
        );
        call.end();
      }),
  };
}
