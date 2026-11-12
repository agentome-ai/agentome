import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { banner } from '@agentome/shared';

import { teamHookMain } from './claude/team-hook.js';
import { pair, ServerError } from './client.js';
import { alive, describe, readConnection, readSettings, readState } from './config.js';
import { stderrLog, UserError, writeConnection } from './config.js';
import type { Settings } from './config.js';
import { ENGINES, runWorker, WAITS_FOR_SANDBOX } from './loop.js';
import { installService, serviceFile, serviceMain, serviceSpec } from './service.js';
import { uninstallService } from './service.js';

// `agentome-worker`: connects this computer, runs the seat, installs it as a service and says
// what it is doing. Its arguments are few enough to read by hand.

const USAGE = `Usage: agentome-worker <command>

  connect <code> --server <url>  Connect this computer with a code from Admin, Computers
  run                            Take runs in this terminal until stopped (Ctrl-C)
  install-service                Take runs in the background while you are logged in
  uninstall-service              Stop and remove the background service
  status                         Show the connection, the last claim and the current run

Settings: AGENTOME_WORKER_HOME, AGENTOME_WORKER_IDLE_MINUTES, AGENTOME_WORKER_KEEP_WORKSPACES.`;

const NOT_CONNECTED =
  'This computer is not connected. Connect it with a code from Admin, Computers: agentome-worker connect <code> --server <url>';

/** Runs one command and answers its exit code. */
export async function main(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const [command, ...rest] = args;
  // The CLI starts it for a team run's hooks (workspace.ts); not a command for people.
  if (command === 'team-hook') return teamHookMain(rest[0]);
  // What the Windows task runs (service.ts); not a command for people either.
  if (command === 'service') return serviceMain(rest[0]);
  try {
    const settings = readSettings(env);
    if (command === 'connect') return await connect(rest, settings);
    if (command === 'status') return status(settings);
    if (command === 'uninstall-service') {
      const removed = await uninstallService();
      console.log(removed ? 'The service is removed.' : 'No service was installed.');
      return 0;
    }
    if (command !== 'run' && command !== 'install-service') {
      console.log(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
    }
    const connection = readConnection(settings.home);
    if (!connection) throw new UserError(NOT_CONNECTED);
    if (command === 'install-service') {
      const spec = serviceSpec(settings.home, env);
      const file = await installService(spec);
      console.log(`The worker runs in the background while you are logged in: ${file}`);
      console.log(`Its log: ${spec.logFile}`);
      return 0;
    }
    process.stdout.write(
      banner(
        `Agentome worker, taking runs from ${connection.serverUrl}`,
        process.stdout.isTTY === true,
      ),
    );
    const stop = new AbortController();
    // Once: a second Ctrl-C ends the process at once.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        stderrLog('info', `${signal}: stopping; a run in progress is cancelled and finished`);
        stop.abort();
      });
    }
    // A disconnected computer exits as cleanly as a stopped one: its service must not restart it.
    const outcome = await runWorker({
      connection,
      settings,
      signal: stop.signal,
      log: stderrLog,
      build: ownBuild(),
    });
    if (outcome === 'disconnected' && existsSync(serviceFile())) {
      // The seat was revoked on the platform: the service would only start again into a 401.
      await uninstallService();
      stderrLog(
        'info',
        'this computer was disconnected from Agentome; its background service is removed',
      );
    }
    return 0;
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    console.error(error.message);
    return 1;
  }
}

async function connect(args: readonly string[], settings: Settings) {
  let server: string | undefined;
  const codes: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (arg === '--server') server = args[++index];
    else if (arg.startsWith('--server=')) server = arg.slice('--server='.length);
    else codes.push(arg);
  }
  const [code] = codes;
  if (codes.length !== 1 || code === undefined || code.startsWith('-') || !server) {
    throw new UserError('Usage: agentome-worker connect <code> --server <url>');
  }
  const serverUrl = serverUrlOf(server);
  // What the person sees in Admin, Computers; they may rename it there.
  // A server seat's container has a random hostname: it is named for what it is.
  const name = settings.server
    ? 'Server'
    : settings.place
      ? 'Place on the server'
      : (hostname().replace(/\.local$/, '') || 'computer').slice(0, 100);
  let seat: { seatId: string; token: string };
  try {
    seat = await pair(
      serverUrl,
      code,
      name,
      settings.server ? 'server' : settings.place ? 'place' : 'computer',
    );
  } catch (error) {
    if (error instanceof ServerError) throw new UserError(error.message);
    throw new UserError(
      `Could not reach ${serverUrl} (${describe(error)}). Check the address, and that this computer can open it in a browser.`,
    );
  }
  writeConnection(settings.home, { serverUrl, seatId: seat.seatId, token: seat.token });
  console.log(`Connected this computer to ${serverUrl} as "${name}".`);
  console.log('Next: agentome-worker run, or agentome-worker install-service for the background.');
  return 0;
}

function status(settings: Settings) {
  const connection = readConnection(settings.home);
  const state = readState(settings.home);
  const pid = state?.pid !== undefined && alive(state.pid) ? state.pid : undefined;
  const run = pid === undefined ? undefined : state?.activeRun;
  const lines = [
    connection
      ? `Connected to ${connection.serverUrl} as seat ${connection.seatId}.`
      : NOT_CONNECTED,
    pid === undefined ? 'Worker: not running.' : `Worker: running, pid ${pid}.`,
    `Last claim: ${state?.lastClaimAt ? ago(state.lastClaimAt) : 'never'}.`,
    `Current run: ${run ? `${run.id}, ${run.agent}${run.task ? `: "${run.task}"` : ''}, started ${ago(run.startedAt)}` : 'none'}.`,
  ];
  for (const engine of pid === undefined ? [] : (state?.signedOut ?? [])) {
    const { name, signIn } = ENGINES[engine] ?? { name: engine, signIn: engine };
    lines.push(`${name}: not signed in, so its runs wait. Run \`${signIn}\` and sign in.`);
  }
  if (pid !== undefined && state?.waitsForSandbox)
    lines.push(`Taking no runs: ${WAITS_FOR_SANDBOX}`);
  if (pid !== undefined && state?.awaySince) {
    lines.push(`Taking no runs: nobody has used this computer since ${ago(state.awaySince)}.`);
  }
  if (['darwin', 'linux', 'win32'].includes(process.platform)) {
    const file = serviceFile();
    lines.push(existsSync(file) ? `Service: installed, ${file}.` : 'Service: not installed.');
  }
  console.log(lines.join('\n'));
  return 0;
}

/**
 * Which build this worker is: the SHA-256 of the file it runs from, which is how the server
 * names the bundle it hands out. The server only compares the two; it never sends a worker here.
 */
function ownBuild(): string | undefined {
  try {
    return createHash('sha256')
      .update(readFileSync(realpathSync(process.argv[1] ?? '')))
      .digest('hex');
  } catch {
    return undefined;
  }
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return `${new Date(iso).toLocaleString()} (${minutes} min ago)`;
}

/** The address as typed, without credentials, query or a trailing slash; a path is kept. */
function serverUrlOf(input: string): string {
  const url = URL.canParse(input.trim()) ? new URL(input.trim()) : undefined;
  if (url?.protocol !== 'https:' && url?.protocol !== 'http:') {
    throw new UserError(`${input} is not a server address: it starts with https:// or http://.`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Whether this module is the program, also when it is started through a link. */
function isEntry(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isEntry()) process.exitCode = await main(process.argv.slice(2));
