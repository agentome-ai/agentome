import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';

// `curl -fsSL <server>/connect | sh -s -- <code>`: the server hands out the worker
// itself, since a company network may have no way to the npm registry. The image puts the
// bundle that `pnpm --filter @agentome/worker build` makes next to this module; a server run
// from a checkout has none, and its pairing command is the checkout's own (seats/routes.ts).

/** Where the image keeps the bundled worker: dist/connect/ beside dist/connect.js. */
export const WORKER_BUNDLE = fileURLToPath(
  new URL('./connect/agentome-worker.mjs', import.meta.url),
);

export interface WorkerBundle {
  readonly body: Buffer;
  readonly sha256: string;
}

/** The bundle and its checksum, read once at start; nothing when this build has none. */
export function loadWorkerBundle(path: string): WorkerBundle | undefined {
  if (!existsSync(path)) return undefined;
  const body = readFileSync(path);
  return { body, sha256: createHash('sha256').update(body).digest('hex') };
}

/** The pairing command a person pastes into a terminal on the computer to connect. */
export function connectCommand(server: string, code: string, bundled: boolean): string {
  return bundled
    ? `curl -fsSL ${server}/connect | sh -s -- ${code}`
    : `pnpm --filter @agentome/worker connect ${code} --server ${server}`;
}

/** What a person runs on a connected computer to bring its worker up to this server's. */
export const updateCommand = (server: string) => `curl -fsSL ${server}/connect | sh -s -- update`;

/** The same two on Windows, in PowerShell: the script is fetched and run as a script block. */
const powershell = (server: string, word: string) =>
  `& ([scriptblock]::Create((irm -UseBasicParsing ${server}/connect.ps1))) ${word}`;
export const windowsConnectCommand = (server: string, code: string) => powershell(server, code);
export const windowsUpdateCommand = (server: string) => powershell(server, 'update');

/** A string for PowerShell, whatever it holds. */
const psQuoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The install script for Windows, in Windows PowerShell 5.1, which every Windows has: the same
 * steps as the sh one, and before them a word on what Windows lacks. The agent's commands run
 * there without a sandbox, so the computer takes runs only once an admin allows it.
 */
export function connectPowershell(server: string, sha256: string): string {
  return `# Connects this Windows computer to Agentome: checks for Node.js and Claude Code or Codex,
# downloads the worker into ~\\.agentome\\bin, checks it, connects with the code from Admin,
# Computers and starts the worker at each logon. In PowerShell:
#   & ([scriptblock]::Create((irm -UseBasicParsing ${server}/connect.ps1))) <code>
# With "update" in place of the code it only replaces the worker and starts it again.
param([string]$Code)
# Not 'Stop' for the whole script: Windows PowerShell would end it at the first line a native
# command writes to stderr. The cmdlets that must not fail quietly say so themselves.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$server = ${psQuoted(server)}
$sha256 = ${psQuoted(sha256)}

if (-not $Code) { throw "Usage: & ([scriptblock]::Create((irm -UseBasicParsing $server/connect.ps1))) <code from Admin, Computers>" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or later is needed: https://nodejs.org' }
# From \`node -v\`: Windows PowerShell drops the quotes inside a native command's argument, so no
# script goes to node -p.
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js 20 or later is needed; this computer has $(node -v)." }
$home_ = if ($env:AGENTOME_WORKER_HOME) { $env:AGENTOME_WORKER_HOME } else { Join-Path $env:USERPROFILE '.agentome' }
$bin = Join-Path $home_ 'bin'
$worker = Join-Path $bin 'agentome-worker.mjs'

# Downloads the worker and keeps it only when it is the one this script names.
function Get-Worker {
  New-Item -ItemType Directory -Force -Path $bin -ErrorAction Stop | Out-Null
  $download = "$worker.download"
  Invoke-WebRequest -UseBasicParsing -Uri "$server/connect/agentome-worker.mjs" -OutFile $download -ErrorAction Stop
  $actual = (Get-FileHash -Algorithm SHA256 -Path $download -ErrorAction Stop).Hash.ToLowerInvariant()
  if ($actual -ne $sha256) {
    Remove-Item -Force $download
    throw 'The downloaded worker does not match its checksum, so nothing was installed. Try again.'
  }
  Move-Item -Force $download $worker -ErrorAction Stop
}

# Whether the worker of this computer has a run in progress, by its own account.
function Test-Running { (node $worker status 2>$null) -match '^Current run: [0-9a-f]{8}-' }

if ($Code -eq 'update') {
  if (-not (Test-Path $worker)) { throw "There is no worker in $bin to update. Connect this computer with a code from Admin, Computers." }
  if (Test-Running) { throw 'A run is in progress on this computer. Update the worker when it has finished.' }
  Get-Worker
  # Installing the task again ends the worker it ran and starts the new one.
  node $worker install-service
  if ($LASTEXITCODE -ne 0) { throw "The worker is updated, but it did not start again. Start it in a terminal: node $worker run" }
  Write-Host "The worker is updated and running again. Check it any time: node $worker status"
  return
}

# A CLI on the PATH, or where its installer put it without adding it there, as the worker looks.
function Find-Cli([string]$Name) {
  $found = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.Source }
  $places = @()
  if ($env:USERPROFILE) { $places += Join-Path $env:USERPROFILE ".local\\bin\\$Name.exe" }
  if ($env:APPDATA) { $places += Join-Path $env:APPDATA "npm\\$Name.cmd" }
  foreach ($path in $places) { if (Test-Path $path) { return $path } }
}
$claude = Find-Cli 'claude'
$codex = Find-Cli 'codex'
if (-not $claude -and -not $codex) { throw 'Claude Code or Codex is needed: install one, run it and sign in with your subscription.' }
# Only a "no" is believed, as on macOS and Linux.
if ($claude -and ((& $claude auth status 2>$null) -match '"loggedIn":\\s*false')) {
  throw 'Claude Code is not signed in: run claude, sign in with your Claude subscription, then run this again.'
}

Write-Host ''
Write-Host 'On Windows the agent''s commands run without a sandbox: they can read what you can read on'
Write-Host 'this computer and reach any address it reaches. This computer takes runs once an admin'
Write-Host 'allows it in Admin, Computers.'
Write-Host ''

Get-Worker
node $worker connect $Code --server $server
if ($LASTEXITCODE -ne 0) { throw 'This computer could not be connected; the message above says why.' }
node $worker install-service
if ($LASTEXITCODE -ne 0) { throw "This computer is connected, but the worker could not be started at logon. Take runs in a terminal instead: node $worker run" }
Write-Host ''
Write-Host "Check it any time: node $worker status"
`;
}

/** A word for sh, whatever it holds. */
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The install script: POSIX sh, so that it runs on a stock macOS or Linux. It checks for Node
 * and Claude Code before it changes anything, keeps the worker only when its SHA-256 matches,
 * and runs the worker's own `connect` and `install-service`. With `update` in place of a code it
 * replaces the worker of a computer that is connected already and starts its service again: the
 * way a new worker gets onto a computer is a person running this, never the server sending one.
 */
export function connectScript(server: string, sha256: string): string {
  return `#!/bin/sh
# Connects this computer to Agentome: checks for Node.js and Claude Code, downloads the worker
# into ~/.agentome/bin, checks it, connects with the code from Admin, Computers and starts the
# worker as a service of your login session. Each run connects the computer anew, with a new
# entry in Admin, Computers; revoke the old one there.
#   curl -fsSL ${server}/connect | sh -s -- <code>
# With "update" in place of the code it only replaces the worker of a computer that is connected
# and starts its service again; the connection stays as it is.
#   curl -fsSL ${server}/connect | sh -s -- update
set -eu

server=${quoted(server)}
sha256=${quoted(sha256)}

fail() {
  printf 'agentome: %s\\n' "$1" >&2
  exit 1
}

# Downloads the worker into $bin and keeps it only when it is the one this script names.
download_worker() {
  # The folders it creates are the person's alone, as the worker makes its own; one that exists
  # keeps its mode.
  umask 077
  mkdir -p "$bin"
  download=$bin/agentome-worker.mjs.download
  curl -fsSL "$server/connect/agentome-worker.mjs" -o "$download"
  actual=$(node -e 'const fs = require("node:fs"); const crypto = require("node:crypto");
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$download")
  if [ "$actual" != "$sha256" ]; then
    rm -f "$download"
    fail 'The downloaded worker does not match its checksum, so nothing was installed. Try again.'
  fi
  chmod 755 "$download"
  mv -f "$download" "$bin/agentome-worker.mjs"
  ln -sf agentome-worker.mjs "$bin/agentome-worker"
}

# Whether the worker of this computer has a run in progress, by its own account.
running() {
  node "$bin/agentome-worker.mjs" status 2>/dev/null | grep -Eq '^Current run: [0-9a-f]{8}-'
}

update() {
  [ -f "$bin/agentome-worker.mjs" ] ||
    fail "There is no worker in $bin to update. Connect this computer with a code from Admin, Computers."
  # Starting the worker again would end its run.
  ! running || fail 'A run is in progress on this computer. Update the worker when it has finished.'
  download_worker
  # Asked again: the worker went on taking runs during the download.
  ! running ||
    fail 'The worker is downloaded, but a run has started meanwhile. Run this again when it has finished.'
  # The service as the worker installed it (service.ts), started again with its file untouched:
  # its PATH and settings stay those of the day the computer was connected.
  restart=yes
  case $(uname -s) in
    Darwin) launchctl kickstart -k "gui/$(id -u)/ai.agentome.worker" >/dev/null 2>&1 || restart=no ;;
    *) systemctl --user restart agentome-worker.service >/dev/null 2>&1 || restart=no ;;
  esac
  [ "$restart" = yes ] ||
    fail "The worker is updated, but its background service did not start again. If it runs in a terminal, stop it there and start it again: $bin/agentome-worker run"
  printf 'The worker is updated and running again. Check it any time: %s status\\n' "$bin/agentome-worker"
}

# Everything happens in main, called on the last line: a download cut short runs nothing.
main() {
  [ "$#" -eq 1 ] || fail "Usage: curl -fsSL $server/connect | sh -s -- <code from Admin, Computers>"
  code=$1
  command -v node >/dev/null 2>&1 || fail 'Node.js 20 or later is needed: https://nodejs.org'
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] || fail "Node.js 20 or later is needed; this computer has $(node -v)."
  home=\${AGENTOME_WORKER_HOME:-$HOME/.agentome}
  bin=$home/bin
  if [ "$code" = update ]; then
    update
    return
  fi
  command -v claude >/dev/null 2>&1 ||
    fail 'Claude Code is needed: install it, run claude and sign in with your Claude subscription.'
  # Only a "no" is believed: a "yes" from auth status has come with a first request that failed,
  # which the first run then reports. A CLI without the command says nothing and passes.
  if claude auth status </dev/null 2>/dev/null | grep -q '"loggedIn": *false'; then
    fail 'Claude Code is not signed in: run claude, sign in with your Claude subscription, then run this again.'
  fi

  download_worker
  node "$bin/agentome-worker.mjs" connect "$code" --server "$server"
  # Connected by now: without a service (no systemd for the user, say) the worker still runs.
  node "$bin/agentome-worker.mjs" install-service ||
    fail "This computer is connected, but the background service could not be installed. Take runs in a terminal instead: $bin/agentome-worker run"
  printf '\\nCheck it any time: %s status\\n' "$bin/agentome-worker"
}

main "$@"
`;
}

/** GET /connect and GET /connect/agentome-worker.mjs, for a build that has the bundle. */
export const connectRoutes: FastifyPluginAsync<{ bundle: WorkerBundle; server: string }> = async (
  app,
  { bundle, server },
) => {
  const script = connectScript(server, bundle.sha256);
  // Both change with every release, and the script names the bundle's checksum: neither may be
  // kept by a cache past the other.
  app.get('/connect', { schema: { hide: true } }, (_request, reply) =>
    reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(script),
  );
  const windows = connectPowershell(server, bundle.sha256);
  app.get('/connect.ps1', { schema: { hide: true } }, (_request, reply) =>
    reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(windows),
  );
  app.get('/connect/agentome-worker.mjs', { schema: { hide: true } }, (_request, reply) =>
    reply
      .header('content-type', 'text/javascript; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(bundle.body),
  );
};
