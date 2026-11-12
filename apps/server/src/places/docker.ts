import { request } from 'node:http';

// The few calls of Docker's Engine API a place needs, over its socket, without a library: what
// goes to Docker is exactly what is written here.

export type DockerAnswer = { status: number; body: unknown };
export type Docker = (method: string, path: string, body?: unknown) => Promise<DockerAnswer>;

/** Docker's API on the socket at `socketPath`, its version named in each path. */
export function dockerAt(socketPath: string): Docker {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const call = request(
        {
          socketPath,
          method,
          path: `/v1.43${path}`,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
          timeout: 120_000,
        },
        (answer) => {
          const chunks: Buffer[] = [];
          answer.on('data', (chunk: Buffer) => chunks.push(chunk));
          answer.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              // Docker answers some calls with plain text, its errors with JSON.
            }
            resolve({ status: answer.statusCode ?? 0, body: parsed });
          });
        },
      );
      call.on('timeout', () => call.destroy(new Error(`Docker did not answer ${method} ${path}`)));
      call.on('error', reject);
      if (payload) call.write(payload);
      call.end();
    });
}

/** Docker's own words for a failed call, or its status. */
export function dockerError(answer: DockerAnswer, what: string): Error {
  const said =
    typeof answer.body === 'object' && answer.body !== null && 'message' in answer.body
      ? String(answer.body.message)
      : `HTTP ${answer.status}`;
  return new Error(`Docker could not ${what}: ${said}`);
}

/**
 * Starts an exec and hands over its stream: Docker answers 101 and the connection becomes the
 * terminal's bytes both ways (a TTY exec is not multiplexed).
 */
export type DockerAttach = (execId: string) => Promise<import('node:stream').Duplex>;

export function dockerAttachAt(socketPath: string): DockerAttach {
  return (execId) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ Detach: false, Tty: true });
      const call = request({
        socketPath,
        method: 'POST',
        path: `/v1.43/exec/${execId}/start`,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          connection: 'Upgrade',
          upgrade: 'tcp',
        },
      });
      call.on('upgrade', (_answer, socket, head) => {
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      call.on('response', (answer) =>
        reject(new Error(`Docker did not open the terminal: HTTP ${answer.statusCode}`)),
      );
      call.on('error', reject);
      call.end(body);
    });
}
