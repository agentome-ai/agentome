import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectPowershell, connectScript } from '../src/connect.js';
import { appFor, REFUSING_DATABASE } from './app.js';

// The one-line installer, run by sh against the real server: a stand-in worker records what it
// was asked to do, and a stand-in `claude` only has to exist. Neither route queries the database.

// What the stand-in worker does with `connect` and `install-service`: it writes them down.
// With NO_SERVICE set, it cannot install the service, as on a Linux without systemd for users;
// with STARTED set, its `status` names a run in progress.
const WORKER = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.RECORD, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.NO_SERVICE && process.argv[2] === 'install-service') process.exit(1);
if (process.env.STARTED && process.argv[2] === 'status')
  console.log('Current run: 0b9f6c1e-7a52-4d0e-9c1b-2f6d8e4a1b3c, Backend developer, started just now.');
`;

// The worker a computer has before an update: it writes down what it was asked, and its `status`
// names a run in progress when RUNNING is set.
const OLD_WORKER = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.RECORD, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(process.env.RUNNING
  ? 'Current run: 0b9f6c1e-7a52-4d0e-9c1b-2f6d8e4a1b3c, Backend developer, started just now.'
  : 'Current run: none.');
`;

// launchctl and systemctl: they write down what they were asked, and fail when NO_RESTART is set.
const SERVICE_MANAGER = `#!/bin/sh
printf '%s\\n' "$(basename "$0") $*" >> "$SERVICES"
[ -z "\${NO_RESTART:-}" ]
`;

let dir: string;
let server: string;
let app: Awaited<ReturnType<typeof appFor>>;
let person: string;

/** A port nothing listens on, so that the server's public URL can name it before it listens. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentome-connect-'));
  writeFileSync(join(dir, 'agentome-worker.mjs'), WORKER);
  const port = await freePort();
  server = `http://127.0.0.1:${port}`;
  app = await appFor(
    REFUSING_DATABASE,
    join(dir, 'data'),
    { AGENTOME_PUBLIC_URL: server },
    { workerBundle: join(dir, 'agentome-worker.mjs') },
  );
  await app.listen({ host: '127.0.0.1', port });
  // A fake `claude`, and node on its own: the folder of the real node may hold a real `claude`.
  mkdirSync(join(dir, 'tools'));
  mkdirSync(join(dir, 'node'));
  symlinkSync(process.execPath, join(dir, 'node', 'node'));
  // It answers `auth status` as Claude Code 2.1.280 does, signed out when LOGGED_OUT is set.
  writeFileSync(
    join(dir, 'tools', 'claude'),
    `#!/bin/sh
if [ "$1 $2" = 'auth status' ]; then
  if [ -n "\${LOGGED_OUT:-}" ]; then printf '{\\n  "loggedIn": false\\n}\\n'; exit 1; fi
  printf '{\\n  "loggedIn": true,\\n  "authMethod": "claude.ai"\\n}\\n'
fi
exit 0
`,
  );
  chmodSync(join(dir, 'tools', 'claude'), 0o755);
  mkdirSync(join(dir, 'system'));
  for (const name of ['launchctl', 'systemctl']) {
    writeFileSync(join(dir, 'system', name), SERVICE_MANAGER);
    chmodSync(join(dir, 'system', name), 0o755);
  }
});

afterAll(async () => {
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  person = mkdtempSync(join(dir, 'home-'));
});

const record = () => join(person, 'record.jsonl');
const installed = () => join(person, '.agentome', 'bin');

/** Runs `command` in sh as a person whose home is `person`, with or without `claude`. */
function sh(
  command: string,
  { claude = true, stdin, env = {} }: { claude?: boolean; stdin?: string; env?: object } = {},
) {
  const path = [
    claude ? join(dir, 'tools') : '',
    join(dir, 'node'),
    join(dir, 'system'),
    '/usr/bin',
    '/bin',
  ];
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      'sh',
      ['-c', command],
      {
        env: {
          PATH: path.filter(Boolean).join(':'),
          HOME: person,
          RECORD: record(),
          SERVICES: join(person, 'services.txt'),
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end(stdin ?? '');
  });
}

const recorded = () =>
  existsSync(record())
    ? readFileSync(record(), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    : [];

describe('curl <server>/connect | sh -s -- <code>', () => {
  it('installs the worker it checked, connects with the code and starts the service', async () => {
    const result = await sh(`curl -fsSL ${server}/connect | sh -s -- K7QX-M2PH`);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(recorded()).toEqual([['connect', 'K7QX-M2PH', '--server', server], ['install-service']]);
    const worker = join(installed(), 'agentome-worker.mjs');
    expect(readFileSync(worker, 'utf8')).toBe(WORKER);
    expect(statSync(worker).mode & 0o777).toBe(0o755);
    expect(statSync(join(person, '.agentome')).mode & 0o777).toBe(0o700);
    // `agentome-worker status` works from the folder; node reads the link's target as a module.
    expect(lstatSync(join(installed(), 'agentome-worker')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(installed(), 'agentome-worker'))).toBe('agentome-worker.mjs');
    expect(result.stdout).toContain(`${join(installed(), 'agentome-worker')} status`);
  });

  it('says the computer is connected when the service cannot be installed', async () => {
    const result = await sh(`curl -fsSL ${server}/connect | sh -s -- K7QX-M2PH`, {
      env: { NO_SERVICE: '1' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('This computer is connected, but the background service');
    expect(result.stderr).toContain(`${join(installed(), 'agentome-worker')} run`);
    expect(recorded()).toEqual([['connect', 'K7QX-M2PH', '--server', server], ['install-service']]);
  });

  it('runs nothing of a script cut short on the way', async () => {
    const script = (await app.inject({ method: 'GET', url: '/connect' })).body;
    const cut = script.slice(0, script.indexOf('main "$@"'));
    const result = await sh('sh -s -- K7QX-M2PH', { stdin: cut });
    expect(result.code).toBe(0);
    expect(existsSync(join(person, '.agentome'))).toBe(false);
    expect(recorded()).toEqual([]);
  });

  it('installs nothing from a download whose checksum does not match', async () => {
    const script = connectScript(server, 'f'.repeat(64));
    const result = await sh('sh -s -- K7QX-M2PH', { stdin: script });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not match its checksum');
    expect(existsSync(join(installed(), 'agentome-worker.mjs'))).toBe(false);
    expect(existsSync(join(installed(), 'agentome-worker.mjs.download'))).toBe(false);
    expect(recorded()).toEqual([]);
  });

  it('changes nothing on a computer without Claude Code', async () => {
    const result = await sh(`curl -fsSL ${server}/connect | sh -s -- K7QX-M2PH`, { claude: false });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Claude Code is needed');
    expect(existsSync(join(person, '.agentome'))).toBe(false);
  });

  it('changes nothing when Claude Code says it is not signed in', async () => {
    const result = await sh(`curl -fsSL ${server}/connect | sh -s -- K7QX-M2PH`, {
      env: { LOGGED_OUT: '1' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Claude Code is not signed in');
    expect(existsSync(join(person, '.agentome'))).toBe(false);
  });

  it('says how to run it when the code is missing', async () => {
    const result = await sh(`curl -fsSL ${server}/connect | sh`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Usage: curl -fsSL ${server}/connect | sh -s -- <code`);
    expect(existsSync(join(person, '.agentome'))).toBe(false);
  });
});

describe('curl <server>/connect | sh -s -- update', () => {
  const worker = () => join(installed(), 'agentome-worker.mjs');
  const services = () =>
    existsSync(join(person, 'services.txt'))
      ? readFileSync(join(person, 'services.txt'), 'utf8').trim().split('\n')
      : [];
  /** A computer that was connected: it has a worker of an earlier build. */
  function connected() {
    mkdirSync(installed(), { recursive: true });
    writeFileSync(worker(), OLD_WORKER);
  }
  const restart =
    process.platform === 'darwin'
      ? `launchctl kickstart -k gui/${process.getuid?.()}/ai.agentome.worker`
      : 'systemctl --user restart agentome-worker.service';

  it('replaces the worker with the one it checked and starts the service again', async () => {
    connected();
    // No Claude Code on the PATH of this shell: an update does not ask for it.
    const result = await sh(`curl -fsSL ${server}/connect | sh -s -- update`, {
      claude: false,
      env: { restart: 'no' },
    });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('The worker is updated and running again.');
    expect(readFileSync(worker(), 'utf8')).toBe(WORKER);
    expect(statSync(worker()).mode & 0o777).toBe(0o755);
    // The old worker was asked what it is doing, then the new one; nothing connected the
    // computer anew.
    expect(recorded()).toEqual([['status'], ['status']]);
    expect(services()).toEqual([restart]);
  });

  it('does not start the service again under a run that began during the download', async () => {
    connected();
    const result = await sh(`curl -fsSL ${server}/connect | sh -s -- update`, {
      // A leftover of the person's shell must not decide whether the service started again.
      env: { STARTED: '1', restart: 'no' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('a run has started meanwhile');
    expect(readFileSync(worker(), 'utf8')).toBe(WORKER);
    expect(services()).toEqual([]);
  });

  it('leaves the worker alone while it has a run in progress', async () => {
    connected();
    const result = await sh(`curl -fsSL ${server}/connect | sh -s -- update`, {
      env: { RUNNING: '1' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('A run is in progress on this computer');
    expect(readFileSync(worker(), 'utf8')).toBe(OLD_WORKER);
    expect(services()).toEqual([]);
  });

  it('keeps the old worker when the download does not match its checksum', async () => {
    connected();
    const result = await sh('sh -s -- update', { stdin: connectScript(server, 'f'.repeat(64)) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not match its checksum');
    expect(readFileSync(worker(), 'utf8')).toBe(OLD_WORKER);
    expect(services()).toEqual([]);
  });

  it('says so when the service did not start again', async () => {
    connected();
    const result = await sh(`curl -fsSL ${server}/connect | sh -s -- update`, {
      env: { NO_RESTART: '1' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('its background service did not start again');
    expect(result.stderr).toContain(`${join(installed(), 'agentome-worker')} run`);
    expect(readFileSync(worker(), 'utf8')).toBe(WORKER);
  });

  it('updates nothing on a computer that was never connected', async () => {
    const result = await sh(`curl -fsSL ${server}/connect | sh -s -- update`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('There is no worker in');
    expect(existsSync(join(person, '.agentome'))).toBe(false);
    expect(recorded()).toEqual([]);
  });
});

describe('the routes', () => {
  it('serve the script and the bundle uncached, the script naming the bundle checksum', async () => {
    const script = await app.inject({ method: 'GET', url: '/connect' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(script.headers['cache-control']).toBe('no-store');
    const sha256 = createHash('sha256').update(WORKER).digest('hex');
    expect(script.body).toContain(`sha256='${sha256}'`);
    expect(script.body).toContain(`server='${server}'`);

    const bundle = await app.inject({ method: 'GET', url: '/connect/agentome-worker.mjs' });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers['cache-control']).toBe('no-store');
    expect(bundle.body).toBe(WORKER);
  });

  it('are a JSON 404 on a server without the bundle', async () => {
    const bare = await appFor(
      REFUSING_DATABASE,
      join(dir, 'bare'),
      {},
      {
        workerBundle: join(dir, 'missing.mjs'),
      },
    );
    for (const url of ['/connect', '/connect/agentome-worker.mjs']) {
      const response = await bare.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    await bare.close();
  });

  it('quote what they put into the script', () => {
    expect(connectScript("http://o'neil.example", 'a'.repeat(64))).toContain(
      `server='http://o'\\''neil.example'`,
    );
  });
});

// The same installer for Windows, run by PowerShell where this machine has it: what it does with
// the server and the worker is the same on every system.
const PWSH = ['/opt/homebrew/bin/pwsh', '/usr/bin/pwsh', '/usr/local/bin/pwsh'].find(existsSync);

// pwsh takes seconds to start on a CI runner, and every test starts it more than once.
describe.skipIf(PWSH === undefined)('the PowerShell installer', { timeout: 30_000 }, () => {
  function pwsh(
    script: string,
    { claude = true, env = {} }: { claude?: boolean; env?: object } = {},
  ) {
    const path = [claude ? join(dir, 'tools') : '', join(dir, 'node'), '/usr/bin', '/bin'];
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        PWSH ?? 'pwsh',
        // Legacy: arguments go to native commands as Windows PowerShell 5.1 passes them, which
        // drops the quotes inside them.
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$PSNativeCommandArgumentPassing = 'Legacy'; ${script}`,
        ],
        {
          env: {
            PATH: path.filter(Boolean).join(':'),
            HOME: person,
            USERPROFILE: person,
            RECORD: record(),
            ...env,
          },
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }
  const fetched = (word: string) =>
    `& ([scriptblock]::Create((irm -UseBasicParsing ${server}/connect.ps1))) ${word}`;
  /** A script given here rather than fetched: one with another checksum, say. */
  function given(script: string, word: string) {
    const file = join(person, 'connect.ps1');
    writeFileSync(file, script);
    return `& ([scriptblock]::Create((Get-Content -Raw '${file}'))) ${word}`;
  }

  it('says what Windows lacks, installs the worker it checked, connects and starts it', async () => {
    const result = await pwsh(fetched('K7QX-M2PH'));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("the agent's commands run without a sandbox");
    expect(recorded()).toEqual([['connect', 'K7QX-M2PH', '--server', server], ['install-service']]);
    expect(readFileSync(join(installed(), 'agentome-worker.mjs'), 'utf8')).toBe(WORKER);
  });

  it('changes nothing when Claude Code says it is not signed in', async () => {
    const result = await pwsh(fetched('K7QX-M2PH'), { env: { LOGGED_OUT: '1' } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Claude Code is not signed in');
    expect(existsSync(join(person, '.agentome'))).toBe(false);
  });

  it('installs nothing from a download whose checksum does not match', async () => {
    const result = await pwsh(given(connectPowershell(server, 'f'.repeat(64)), 'K7QX-M2PH'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not match its checksum');
    expect(existsSync(join(installed(), 'agentome-worker.mjs'))).toBe(false);
    expect(recorded()).toEqual([]);
  });

  it("finds Claude Code where its installer put it, off the person's PATH", async () => {
    mkdirSync(join(person, '.local', 'bin'), { recursive: true });
    copyFileSync(join(dir, 'tools', 'claude'), join(person, '.local', 'bin', 'claude.exe'));
    chmodSync(join(person, '.local', 'bin', 'claude.exe'), 0o755);
    const result = await pwsh(fetched('K7QX-M2PH'), { claude: false, env: { LOGGED_OUT: '1' } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Claude Code is not signed in');
  });

  it('changes nothing on a computer without Claude Code or Codex', async () => {
    const result = await pwsh(fetched('K7QX-M2PH'), { claude: false });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Claude Code or Codex is needed');
    expect(existsSync(join(person, '.agentome'))).toBe(false);
  });

  it('updates the worker of a connected computer and starts it again', async () => {
    mkdirSync(installed(), { recursive: true });
    writeFileSync(join(installed(), 'agentome-worker.mjs'), OLD_WORKER);
    const result = await pwsh(fetched('update'), { claude: false });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('The worker is updated and running again.');
    expect(readFileSync(join(installed(), 'agentome-worker.mjs'), 'utf8')).toBe(WORKER);
    expect(recorded()).toEqual([['status'], ['install-service']]);
  });

  it('leaves the worker alone while it has a run in progress', async () => {
    mkdirSync(installed(), { recursive: true });
    writeFileSync(join(installed(), 'agentome-worker.mjs'), OLD_WORKER);
    const result = await pwsh(fetched('update'), { env: { RUNNING: '1' } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('A run is in progress on this computer');
    expect(readFileSync(join(installed(), 'agentome-worker.mjs'), 'utf8')).toBe(OLD_WORKER);
  });

  it('quotes what it puts into the script', () => {
    expect(connectPowershell("http://o'neil.example", 'a'.repeat(64))).toContain(
      "$server = 'http://o''neil.example'",
    );
  });
});
