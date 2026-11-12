import { readFileSync } from 'node:fs';
import { Duplex } from 'node:stream';

// The few calls of the Kubernetes API a place needs, with fetch and the WebSocket Node has,
// without a library: what goes to the cluster is exactly what is written here. The launcher
// runs in the cluster under its own service account; its manifest sets NODE_EXTRA_CA_CERTS to
// the account's CA, so Node trusts the API server's certificate.

export type KubeAnswer = { status: number; body: unknown };
/** A call on the namespace's API: `path` after `/api/v1/namespaces/<namespace>`. */
export type Kube = (method: string, path: string, body?: unknown) => Promise<KubeAnswer>;
/** A command in a pod's container: its WebSocket, as a stream, and what else it carries. */
export type KubeExec = (
  pod: string,
  command: string[],
  options: { tty: boolean },
) => Promise<ExecStream>;

export interface ExecStream {
  /** stdin in, stdout and stderr out. */
  stream: Duplex;
  resize: (cols: number, rows: number) => void;
  /** Ends with the command: whether Kubernetes said it succeeded. */
  ended: Promise<boolean>;
}

const ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

/** The cluster the launcher runs in, as its service account sees it. */
export function inCluster(env: NodeJS.ProcessEnv = process.env) {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) return undefined;
  const namespace = readFileSync(`${ACCOUNT}/namespace`, 'utf8').trim();
  const base = `https://${host.includes(':') ? `[${host}]` : host}:${port}/api/v1/namespaces/${namespace}`;
  // The token is projected and turns over: read at each call.
  const token = () => readFileSync(`${ACCOUNT}/token`, 'utf8').trim();
  return { namespace, kube: kubeAt(base, token), exec: kubeExecAt(base, token) };
}

export function kubeAt(base: string, token: () => string, fetchImpl: typeof fetch = fetch): Kube {
  return async (method, path, body) => {
    const answer = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token()}`,
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await answer.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Kubernetes answers JSON; anything else is shown as it came.
    }
    return { status: answer.status, body: parsed };
  };
}

/** Kubernetes' own words for a failed call, or its status. */
export function kubeError(answer: KubeAnswer, what: string): Error {
  const said =
    typeof answer.body === 'object' && answer.body !== null && 'message' in answer.body
      ? String(answer.body.message)
      : `HTTP ${answer.status}`;
  return new Error(`Kubernetes could not ${what}: ${said}`);
}

// The exec protocol's channels: the first byte of each binary message.
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const STATUS = 3;
const RESIZE = 4;

export function kubeExecAt(base: string, token: () => string): KubeExec {
  return (pod, command, { tty }) =>
    new Promise((resolve, reject) => {
      const query = new URLSearchParams({
        container: 'place',
        // A terminal takes keystrokes; a command of the launcher's, none.
        stdin: String(tty),
        stdout: 'true',
        stderr: String(!tty),
        tty: String(tty),
      });
      for (const part of command) query.append('command', part);
      const url = `${base.replace(/^http/, 'ws')}/pods/${pod}/exec?${query.toString()}`;
      // Node's WebSocket takes an init with headers, as browsers' does not, and the DOM's type
      // the compiler has knows only protocols: the API server wants the token.
      const init = {
        protocols: ['v4.channel.k8s.io'],
        headers: { authorization: `Bearer ${token()}` },
      } as unknown as string[];
      const socket = new WebSocket(url, init);
      socket.binaryType = 'arraybuffer';
      let succeeded = false;
      let settle: (value: boolean) => void = () => {};
      const ended = new Promise<boolean>((done) => (settle = done));
      const send = (channel: number, data: Uint8Array) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const frame = new Uint8Array(data.length + 1);
        frame[0] = channel;
        frame.set(data, 1);
        socket.send(frame);
      };
      const stream = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          send(STDIN, chunk);
          callback();
        },
        final(callback) {
          socket.close();
          callback();
        },
        destroy(error, callback) {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close();
          }
          callback(error);
        },
      });
      socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const data = new Uint8Array(event.data);
        const channel = data[0];
        if (channel === STDOUT || channel === STDERR) stream.push(Buffer.from(data.subarray(1)));
        if (channel === STATUS) {
          const status = JSON.parse(Buffer.from(data.subarray(1)).toString('utf8')) as {
            status?: string;
          };
          succeeded = status.status === 'Success';
        }
      };
      socket.onopen = () =>
        resolve({
          stream,
          ended,
          resize: (cols, rows) =>
            send(RESIZE, Buffer.from(JSON.stringify({ Width: cols, Height: rows }))),
        });
      socket.onerror = () => reject(new Error('Kubernetes did not open the command in the place'));
      socket.onclose = () => {
        settle(succeeded);
        stream.push(null);
        stream.destroy();
      };
    });
}
