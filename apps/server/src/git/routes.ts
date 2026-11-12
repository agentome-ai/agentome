import { tagLog } from '../logs/context.js';
import { span, spanUrl } from '../logs/span.js';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { and, type Db, eq, runs, tasks } from '@agentome/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { connectionsKey } from '../connections/crypto.js';
import { connectionFor, gitRemoteOf } from '../connections/service.js';
import { errorHandler } from '../errors.js';
import { isAgentBranch } from '../mcp/tools.js';
import { isWorking } from '../runs/service.js';
import { isGitPassword, repositoryPath } from './credential.js';
import {
  emptyPack,
  FLUSH,
  isZero,
  parsePushHead,
  pkt,
  type PushCommand,
  type PushHead,
  refusedRefs,
  reportStatus,
} from './pktline.js';
import { taskRepository } from '../tasks/repository.js';

// The git proxy: smart HTTP for the run's own repository, with the run's git password
// in front and the connection's token behind. Fetches pass through as bytes; a push is read up
// to its commands, held to agent/* without deletes, and checked for rewritten history once the
// host has its commits.

const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);
const PATH = /^(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The commands of a push: thousands of refs fit; the pack after them is never held. */
const MAX_HEAD = 64 * 1024;
/** A receive-pack answer: its report and the host's progress lines. */
const MAX_REPORT = 4 * 1024 * 1024;
const REQUEST_TYPES = [
  'application/x-git-upload-pack-request',
  'application/x-git-receive-pack-request',
];

/** What git shows the agent: plain text, which it prints, and a status. */
class GitRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const unauthorized = () =>
  new GitRefusal(401, 'Sign in with the git password of a live run', {
    'www-authenticate': 'Basic realm="Agentome", charset="UTF-8"',
  });

type Remote = Awaited<ReturnType<typeof gitRemoteOf>>;

export const gitRoutes: FastifyPluginAsync<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const key = connectionsKey(config.secretKey);

  // The body stays a stream: a pack can be any size, and only a push's head is ever read.
  app.addContentTypeParser(REQUEST_TYPES, (_request, payload, done) => done(null, payload));
  app.setErrorHandler((error, request, reply) => {
    if (!(error instanceof GitRefusal)) return errorHandler(error, request, reply);
    return reply
      .code(error.status)
      .headers(error.headers)
      .type('text/plain; charset=utf-8')
      .send(`${error.message}\n`);
  });

  /** The live run the Basic credentials open, and the remote of its repository if `path` is it. */
  async function remoteOf(request: FastifyRequest, path: string): Promise<Remote> {
    const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(request.headers.authorization ?? '');
    const [user = '', ...rest] = Buffer.from(match?.[1] ?? '', 'base64')
      .toString('utf8')
      .split(':');
    if (!UUID.test(user) || !isGitPassword(config.secretKey, user, rest.join(':'))) {
      throw unauthorized();
    }
    const [run] = await db
      .select({ agentId: runs.agentId, repository: taskRepository })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      // The reaper's minutes past the time limit: a run done in its last seconds still pushes.
      .where(and(eq(runs.id, user), isWorking(config.orphanMinutes)));
    if (!run) throw unauthorized();
    tagLog({ runId: user });
    const connection = await connectionFor(db, run.agentId, run.repository);
    const own = run.repository && repositoryPath(run.repository);
    if (!connection || !own || own.toLowerCase() !== path.toLowerCase()) {
      throw new GitRefusal(
        404,
        "Agentome opens only this run's own repository, and only once an admin has connected its host",
      );
    }
    return gitRemoteOf(db, key, connection.id, own);
  }

  app.get<{ Params: { '*': string }; Querystring: { service?: string } }>(
    '/git/*',
    { schema: { hide: true } },
    async (request, reply) => {
      const [, path = '', action] = PATH.exec(request.params['*']) ?? [];
      const service = request.query.service ?? '';
      if (action !== 'info/refs' || !SERVICES.has(service)) {
        throw new GitRefusal(404, 'Agentome speaks the smart HTTP protocol of git only');
      }
      const remote = await remoteOf(request, path);
      const response = await upstream(remote, `info/refs?service=${service}`, {
        method: 'GET',
        headers: passOn(request, ['accept', 'git-protocol', 'user-agent']),
        signal: hangUp(reply),
      });
      return relay(reply, response);
    },
  );

  app.post<{ Params: { '*': string } }>(
    '/git/*',
    { schema: { hide: true } },
    async (request, reply) => {
      const [, path = '', action] = PATH.exec(request.params['*']) ?? [];
      if (!action || !SERVICES.has(action)) throw new GitRefusal(404, 'Not a git service');
      const remote = await remoteOf(request, path);
      const body = request.body as Readable;
      const signal = hangUp(reply);
      if (action === 'git-upload-pack') {
        const headers = passOn(request, [
          'content-type',
          'content-encoding',
          'accept',
          'git-protocol',
          'user-agent',
        ]);
        return relay(
          reply,
          await upstream(remote, action, { method: 'POST', headers, body: toWeb(body), signal }),
        );
      }

      // git sends a push uncompressed; a compressed one would have to be unpacked to be read.
      const encoding = request.headers['content-encoding'];
      if (encoding && encoding !== 'identity')
        throw new GitRefusal(415, 'Send the push uncompressed');
      const chunks = body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      const { head, push } = await readHead(chunks);
      const capabilities = push.capabilities;
      // GitLab acts on push options as the token's user — merge_request.create, auto-merge,
      // ci.variable — which would open a change request past the owner's approval.
      // And a capability the proxy does not know is one whose effect on the host it cannot tell.
      const unknown = capabilities.find((capability) => !PASSED_ON.has(capability));
      const options =
        unknown === 'push-options'
          ? 'Agentome does not pass push options on: open a change request with its tool'
          : unknown !== undefined
            ? `Agentome does not pass on a push that asks for ${unknown.replace(/[^\x21-\x7e]/g, '?').slice(0, 40)}`
            : undefined;
      const refused = push.commands.map((command) => options ?? refusalOf(command));
      if (refused.some(Boolean)) {
        drain(chunks, request);
        const results = push.commands.map((command, i) => ({
          ref: command.ref,
          refusal: refused[i] ?? 'not pushed: another ref in this push was refused',
        }));
        return report(reply, reportStatus(results, capabilities));
      }

      const rest = Readable.from(
        (async function* () {
          yield head;
          for (let next = await chunks.next(); !next.done; next = await chunks.next())
            yield next.value;
        })(),
      );
      const headers = passOn(request, ['content-type', 'accept', 'user-agent']);
      const response = await upstream(remote, action, {
        method: 'POST',
        headers,
        body: toWeb(rest),
        signal,
      });
      const answer = await readAll(response);
      const rewritten = await rewrites(remote, push, answer, request);
      if (rewritten.length === 0) return report(reply, answer);

      const restored = await rollback(remote, rewritten).catch((error: unknown) => {
        request.log.error({ err: error }, 'the git proxy could not put a rewritten branch back');
        return rewritten.map(() => false);
      });
      const results = push.commands.map((command) => {
        const i = rewritten.indexOf(command);
        if (i < 0) return { ref: command.ref };
        return {
          ref: command.ref,
          refusal: restored[i]
            ? 'rewrites history: Agentome put the branch back; fetch, rebase onto it and push again'
            : "rewrites history, and Agentome could not put the branch back; tell the agent's owner",
        };
      });
      return report(reply, reportStatus(results, capabilities));
    },
  );

  /** The updates the host took that do not keep the branch's history: those to put back. */
  async function rewrites(remote: Remote, push: PushHead, answer: Buffer, request: FastifyRequest) {
    // Only the host's own refusal clears a ref. One it says nothing of may have been updated:
    // a push that asks for no report gets none, and its refs move all the same.
    const refused = refusedRefs(answer, push.capabilities);
    const found: PushCommand[] = [];
    for (const command of push.commands.filter((c) => !isZero(c.old) && !refused?.has(c.ref))) {
      const kept = await remote.host
        .isAncestor(remote.path, command.old, command.new)
        .catch((error: unknown) => {
          // Unchecked is not kept: the branch goes back, and the agent pushes again. Unrelated
          // histories land here too: the hosts answer 404 for two commits with no merge base.
          request.log.warn(
            { err: error },
            'the git proxy could not check a push for rewritten history',
          );
          return false;
        });
      if (!kept) found.push(command);
    }
    return found;
  }
};

/** What git's own client asks of a host with a push, push options aside (send-pack.c). */
const PASSED_ON = new Set([
  'report-status',
  'report-status-v2',
  'side-band',
  'side-band-64k',
  'quiet',
  'atomic',
  'ofs-delta',
  'object-format',
  'agent',
  'session-id',
]);

/** Why a command may not pass, or nothing: agent/* branches only, and none deleted. */
function refusalOf(command: PushCommand): string | undefined {
  const branch = command.ref.startsWith('refs/heads/')
    ? command.ref.slice('refs/heads/'.length)
    : '';
  if (!isAgentBranch(branch))
    return 'Agentome takes pushes to agent/* branches only, such as agent/add-readme';
  if (isZero(command.new)) return 'Agentome does not delete branches';
  return undefined;
}

/** The commands at the head of a push, and the bytes read to find them. */
async function readHead(chunks: AsyncIterator<Buffer>) {
  let head = Buffer.alloc(0);
  for (;;) {
    const push = parsePushHead(head);
    if (typeof push === 'object') return { head, push };
    if (push !== 'incomplete') throw new GitRefusal(400, push);
    if (head.length > MAX_HEAD) throw new GitRefusal(413, 'This push names too many refs at once');
    const next = await chunks.next();
    if (next.done) throw new GitRefusal(400, 'This push ended before its commands did');
    head = Buffer.concat([head, next.value]);
  }
}

/** Reads what is left of a refused push, so that git hears the answer instead of a reset. */
function drain(chunks: AsyncIterator<Buffer>, request: FastifyRequest) {
  void (async () => {
    for (let next = await chunks.next(); !next.done; next = await chunks.next());
  })().catch((error: unknown) => request.log.debug({ err: error }, 'a refused push hung up'));
}

/** Puts rewritten branches back where they were: an empty pack, since the host has the commits. */
async function rollback(remote: Remote, commands: PushCommand[]) {
  const sha256 = (commands[0]?.old.length ?? 40) === 64;
  const capabilities = ['report-status', ...(sha256 ? ['object-format=sha256'] : [])].join(' ');
  const lines = commands.map((c, i) =>
    pkt(`${c.new} ${c.old} ${c.ref}${i === 0 ? `\0${capabilities}` : ''}\n`),
  );
  const response = await upstream(remote, 'git-receive-pack', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
      // Our own name: the client's could carry a character that stops the request being sent.
      'user-agent': 'git/agentome',
    },
    body: Buffer.concat([...lines, FLUSH, emptyPack(sha256)]),
  });
  const said = (await readAll(response)).toString('utf8');
  return commands.map((c) => said.includes(`ok ${c.ref}\n`));
}

/** One request to the host with the connection's token; its refusals in words git prints. */
async function upstream(
  remote: Remote,
  suffix: string,
  init: { method: string; headers: Record<string, string>; body?: BodyInit; signal?: AbortSignal },
): Promise<Response> {
  let response: Response;
  try {
    // Redirects are not followed: the token rides in a header.
    response = await span(
      `git ${init.method} ${spanUrl(`${remote.url}/${suffix}`)}`,
      () =>
        fetch(`${remote.url}/${suffix}`, {
          ...init,
          headers: { ...init.headers, authorization: remote.authorization },
          redirect: 'manual',
          duplex: 'half',
        } as RequestInit),
      (answer) => ({ status: answer.status }),
    );
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    throw new GitRefusal(502, `The code host could not be reached: ${said}`);
  }
  if (response.status === 200) return response;
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    throw new GitRefusal(
      502,
      "The code host refused this connection's token: ask an admin to check it in Admin, Connections",
    );
  }
  if (response.status === 404) {
    throw new GitRefusal(
      404,
      'The code host has no such repository, or this connection cannot see it',
    );
  }
  throw new GitRefusal(502, `The code host answered ${String(response.status)}`);
}

function passOn(request: FastifyRequest, names: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of names) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

/** Aborts the host's side when git hangs up before the answer is out. */
function hangUp(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** The host's answer, streamed. fetch has already undone any compression, so that header stays. */
function relay(reply: FastifyReply, response: Response) {
  reply.header('content-type', response.headers.get('content-type') ?? 'application/octet-stream');
  reply.header('cache-control', 'no-cache');
  if (!response.body) return reply.send(Buffer.alloc(0));
  return reply.send(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>));
}

function report(reply: FastifyReply, body: Buffer) {
  return reply
    .header('content-type', 'application/x-git-receive-pack-result')
    .header('cache-control', 'no-cache')
    .send(body);
}

async function readAll(response: Response): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)) {
    size += (chunk as Buffer).length;
    if (size > MAX_REPORT)
      throw new GitRefusal(502, 'The code host answered this push at too great a length');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const toWeb = (stream: Readable) => Readable.toWeb(stream) as unknown as BodyInit;
