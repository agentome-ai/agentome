import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { banner } from './banner.js';
import { connect, updateWorker, workerStatus } from './connect.js';
import { askOptions, type Deps, envValue, install } from './install.js';
import { bridge } from './mcp.js';
import { backup, logs, serverDir, status, update } from './server.js';
import { askAt, exec, Refusal } from './system.js';

// agentome: one program for Agentome's two installs. `install` sets up the server on this machine;
// `connect` connects this computer to a server, for agents that run on it; `mcp` is the server's
// MCP for a client that starts a program. The rest is for the server's admin. It is the same program wherever it runs: from npm, npx, or later the image.

// The release this program installs: its own version, put here by the build.
declare const AGENTOME_VERSION: string | undefined;
const VERSION = typeof AGENTOME_VERSION === 'string' ? AGENTOME_VERSION : '0.4.0';

const USAGE = `agentome ${VERSION}: AI employees, on your own servers

  agentome install [--dir <folder>] [--domain <host>] [--port <n>] [--places | --no-places] [--yes]
      Sets up the Agentome server on this machine with Docker: asks for the folder, the address
      people open and whether people get places on the server, then starts it.
  agentome connect <code> <server>
      Connects this computer to your company's Agentome, with the code from Admin, Computers.
  agentome connect update [<server>]     The newest worker from the server, started again.
  agentome connect status                What this computer's worker is doing.

  AGENTOME_URL=<server> AGENTOME_TOKEN=<token> agentome mcp
      Agentome's MCP over stdio, for an MCP client that starts a program: manage agents, teams,
      projects and tasks as yourself, with a token from API tokens.

  agentome status | update | backup [<file>] | logs [<service>]   [--dir <folder>]
      For the server's admin: what runs, the release of this program (a backup first),
      a backup of the database (the secret key stays out), and the logs.

  agentome --version`;

/** --name value and --flag, and what is left in order. */
export function parse(args: string[]) {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    if (inline !== undefined) flags.set(name, inline);
    else if (['yes', 'places', 'no-places', 'help', 'version'].includes(name))
      flags.set(name, true);
    else flags.set(name, args[++i] ?? '');
  }
  return { flags, rest };
}

const releaseBase = (version: string) =>
  process.env.AGENTOME_INSTALL_BASE ??
  `https://raw.githubusercontent.com/agentome-ai/agentome/v${version}`;

export async function main(argv: string[]): Promise<number> {
  const { flags, rest } = parse(argv);
  const [command, ...args] = rest;
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const interactive = process.stdin.isTTY === true && flags.get('yes') !== true;
  const deps: Deps = { exec, fetch, ask: askAt(interactive), say };
  const text = (name: string) => {
    const value = flags.get(name);
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  try {
    if (flags.has('version') && !command) {
      say(VERSION);
      return 0;
    }
    switch (command) {
      case 'install': {
        await banner(`Installing Agentome ${VERSION}`);
        const port = text('port') === undefined ? undefined : Number(text('port'));
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
          throw new Refusal('--port takes a port number, such as 3300');
        }
        const given = {
          ...(text('dir') && { dir: text('dir') }),
          ...(text('domain') && { domain: text('domain') }),
          ...(port !== undefined && { port }),
          ...(flags.has('places') && { places: true }),
          ...(flags.has('no-places') && { places: false }),
        };
        const options = await askOptions(
          { dir: './agentome', version: VERSION, base: releaseBase(VERSION) },
          given,
          deps,
        );
        await install(options, deps);
        return 0;
      }
      case 'connect': {
        const connectDeps = { exec, fetch, say };
        if (args[0] === 'status') await workerStatus(connectDeps);
        else if (args[0] === 'update') await updateWorker(args[1], connectDeps);
        else {
          const [code, server] = args;
          if (!code || !server)
            throw new Refusal('Usage: agentome connect <code from Admin, Computers> <server>');
          await banner('Connecting this computer');
          await connect(code, server, connectDeps);
        }
        return 0;
      }
      case 'mcp': {
        const url = process.env.AGENTOME_URL;
        const token = process.env.AGENTOME_TOKEN;
        if (!url || !token) {
          throw new Refusal(
            'agentome mcp needs AGENTOME_URL, your server, and AGENTOME_TOKEN, a token from API tokens',
          );
        }
        await bridge({
          url,
          token,
          fetch,
          input: process.stdin,
          output: process.stdout,
          log: (line) => process.stderr.write(`${line}\n`),
        });
        return 0;
      }
      case 'status':
        await status(serverDir(text('dir')), deps);
        return 0;
      case 'update': {
        const dir = serverDir(text('dir'));
        const running = envValue(readFileSync(join(dir, '.env'), 'utf8'), 'AGENTOME_VERSION');
        const version = args[0] ?? VERSION;
        if (running === version) {
          say(
            `Agentome ${version} is what runs. For a newer release, update this program first: npm install -g agentome@latest`,
          );
          return 0;
        }
        await update(dir, { version, base: releaseBase(version) }, deps);
        return 0;
      }
      case 'backup':
        await backup(serverDir(text('dir')), args[0], deps);
        return 0;
      case 'logs':
        await logs(serverDir(text('dir')), args[0], deps);
        return 0;
      default:
        say(USAGE);
        return command === undefined || command === 'help' || flags.has('help') ? 0 : 2;
    }
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`agentome: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
