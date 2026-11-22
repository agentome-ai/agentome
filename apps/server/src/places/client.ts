import { request } from 'node:http';
import type { Duplex } from 'node:stream';
import { launcherKey, placesKey } from './keys.js';
import { AppError } from '../errors.js';
import type { ServiceSpec } from '../projects/devcontainer.js';
import { RunAddresses } from './launcher.js';
import {
  newNonce,
  NONCE_HEADER,
  type PlaceState,
  SIGNATURE_HEADER,
  signOrder,
  TIME_HEADER,
} from './protocol.js';

// The server's side of the place launcher: each order signed with the key both derive from the
// installation's secret.

export type Launcher = ReturnType<typeof placeLauncher>;

export function placeLauncher(url: string, secretKey: string, fetchImpl: typeof fetch = fetch) {
  const key = launcherKey(placesKey(secretKey));
  async function order(method: string, path: string, body?: unknown, timeoutMs = 180_000) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const time = String(Date.now());
    const nonce = newNonce();
    let answer: Response;
    try {
      answer = await fetchImpl(`${url}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          [TIME_HEADER]: time,
          [NONCE_HEADER]: nonce,
          [SIGNATURE_HEADER]: signOrder(key, method, path, time, nonce, text),
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
      | {
          state?: PlaceState;
          startedAt?: string;
          terminals?: number;
          diskBytes?: number;
          error?: string;
        }
      | undefined;
    if (!answer.ok) {
      const message = said?.error ?? `The place launcher answered ${answer.status}`;
      throw new AppError(answer.status === 409 ? 'place_exists' : 'place_unavailable', message);
    }
    return said;
  }
  return {
    state: async (id: string) => (await order('GET', `/places/${id}`))?.state ?? 'none',
    /**
     * The state, since when an awake place has been awake, and the bytes its volumes hold where
     * the launcher counts them (Docker).
     */
    status: async (id: string) => {
      const said = await order('GET', `/places/${id}`);
      return {
        state: said?.state ?? 'none',
        startedAt: said?.startedAt,
        terminals: said?.terminals ?? 0,
        diskBytes: said?.diskBytes,
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
    /**
     * Makes a run's own container in the person's place and starts it; with the
     * project's services on Kubernetes, which may take minutes to pull.
     */
    startRun: async (
      id: string,
      runId: string,
      run: {
        folder?: string;
        shape?: { project: string; hash: string; services: ServiceSpec[] };
        engine?: 'claude-code' | 'codex';
      },
    ) => {
      const said = RunAddresses.safeParse(
        await order('PUT', `/places/${id}/runs/${runId}`, run, 15 * 60_000),
      );
      if (!said.success) {
        throw new AppError('place_unavailable', 'The place launcher did not say where the run is');
      }
      return said.data;
    },
    /** Deletes a run's container, with everything still running in it. */
    endRun: async (id: string, runId: string) =>
      void (await order('DELETE', `/places/${id}/runs/${runId}`)),
    resize: async (id: string, cols: number, rows: number) =>
      void (await order('POST', `/places/${id}/resize`, { cols, rows })),
    /** A terminal in the person's place: the launcher's stream, both ways. */
    terminal: (id: string) =>
      new Promise<Duplex>((resolve, reject) => {
        const path = `/places/${id}/terminal`;
        const time = String(Date.now());
        const nonce = newNonce();
        const call = request(`${url}${path}`, {
          method: 'GET',
          headers: {
            connection: 'Upgrade',
            upgrade: 'tcp',
            [TIME_HEADER]: time,
            [NONCE_HEADER]: nonce,
            [SIGNATURE_HEADER]: signOrder(key, 'GET', path, time, nonce, ''),
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
