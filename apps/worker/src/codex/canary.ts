import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliCommand } from '../platform.js';

// Before a Codex run in a person's place, in its CLI container: the unmodified Codex, against a
// model of the worker's own that asks for one command, which says where it ran and whether it
// sees the person's sign-in. The run goes on only when the command ran in the sandbox and saw no
// sign-in: a Codex version whose executor (`codex exec-server`, experimental) changed how it
// chooses where to run would fail here, before an agent's first command. No subscription is used:
// the model is the worker's, on the container's loopback.

/** The one command the canary's model asks for. */
const COMMAND =
  'if [ -d /run/agentome-cli ]; then echo CANARY-BRAIN; else echo CANARY-HANDS; fi; ' +
  'if cat /home/node/.codex/auth.json >/dev/null 2>&1; then echo CANARY-LEAK; else echo CANARY-SEALED; fi';

const PROVIDER = 'agentome-canary';
const CANARY_MS = 60_000;

/** A model in Responses API form that asks for COMMAND, then ends; the command's output it heard. */
function scriptedModel(): { server: Server; heard: () => string } {
  let turn = 0;
  let heard = '';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      if (!request.url?.endsWith('/responses')) {
        response.writeHead(404).end();
        return;
      }
      turn += 1;
      const id = `resp_${turn}`;
      const usage = {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      };
      let item: object;
      if (turn === 1) {
        item = {
          type: 'function_call',
          id: 'fc_canary',
          call_id: 'call_canary',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: COMMAND }),
        };
      } else {
        try {
          const input = (JSON.parse(body) as { input?: { type?: string; output?: unknown }[] })
            .input;
          heard = (input ?? [])
            .filter((entry) => entry.type === 'function_call_output')
            .map((entry) =>
              typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output),
            )
            .join('\n');
        } catch {
          heard = '';
        }
        item = {
          type: 'message',
          id: 'msg_canary',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        };
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, usage } },
      ]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });
  return { server, heard: () => heard };
}

/** What the canary found: the command's output says where it ran and what it saw. */
export function canaryVerdict(output: string): string | undefined {
  if (output.includes('CANARY-BRAIN') || output.includes('CANARY-LEAK')) {
    return "Codex ran a command beside the person's sign-in";
  }
  if (!output.includes('CANARY-HANDS') || !output.includes('CANARY-SEALED')) {
    return output.trim() ? 'Codex ran no command in the sandbox' : 'Codex ran no command at all';
  }
  return undefined;
}

/**
 * `agentome-worker codex-canary <executor url> [codex]`, in a Codex run's CLI container: 0 when
 * Codex ran the command on its executor in the sandbox and saw no sign-in, 1 and why otherwise.
 */
export async function canaryMain(
  [execServer, codexPath = 'codex']: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!execServer) {
    process.stderr.write('codex-canary: no executor to check\n');
    return 2;
  }
  const { server, heard } = scriptedModel();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  // A Codex home of its own: the person's, with their sign-in, plays no part.
  const home = mkdtempSync(join(tmpdir(), 'agentome-canary-'));
  try {
    const [file, ...first] = cliCommand(codexPath, env);
    const args = [
      ...first,
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      // A folder both containers have: the executor runs the command where Codex says.
      '-C',
      '/tmp',
      '-m',
      PROVIDER,
      '-c',
      `model_providers.${PROVIDER}={name="${PROVIDER}",base_url="http://127.0.0.1:${port}/v1",env_key="AGENTOME_CANARY_KEY",wire_api="responses"}`,
      '-c',
      `model_provider="${PROVIDER}"`,
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="danger-full-access"',
      '--disable',
      'hooks',
      'Run the command you are given.',
    ];
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(file, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: home,
          CODEX_HOME: home,
          AGENTOME_CANARY_KEY: 'canary',
          CODEX_EXEC_SERVER_URL: execServer,
          // The test's stand-in reads these; the real Codex does not.
          ...Object.fromEntries(
            Object.entries(env).filter(([name]) => name.startsWith('CODEX_FAKE_')),
          ),
        },
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), CANARY_MS);
      child.once('error', () => resolve(null));
      child.once('close', (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
    const why =
      code === 0 ? canaryVerdict(heard()) : `Codex ended with ${String(code)} in its check`;
    if (why) {
      process.stderr.write(`${why}\n`);
      return 1;
    }
    return 0;
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}
