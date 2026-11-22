import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// The person's sign-in to the CLIs in their place, which each run's container mounts:
// `~/.claude` and `~/.codex` of the place's home. A run may write there, since the CLIs refresh
// their tokens there, and what it wrote would be read as instructions or run as commands by the
// next run of any of the person's agents, by the place's check of the sign-in and by the person's
// own CLI in its terminal: an MCP server, a hook, an API key helper. So the place keeps only the
// sign-in, by name, and takes out everything else, whatever a CLI version adds: before each run
// and after it, and before each check. The sign-in files themselves are never read.

/** What of the CLIs' folders is the sign-in: every other name goes. */
const SIGN_IN = {
  '.claude': ['.credentials.json', '.claude.json'],
  '.codex': ['auth.json'],
};

/**
 * What of Claude Code's account file stays: the account and that it was set up. Not its MCP
 * servers, nor its per-folder settings (`projects`), whose tools and servers a run could add.
 */
const ACCOUNT = [
  'oauthAccount',
  'userID',
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'theme',
  'installMethod',
  'autoUpdates',
  'firstStartTime',
];

/** The account file with its account alone; nothing when it is not one. */
function accountOnly(path: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const kept = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => ACCOUNT.includes(key)),
    );
    return `${JSON.stringify(kept, null, 2)}\n`;
  } catch {
    return undefined;
  }
}

/** Makes the sign-in folders ready for a run's container, or a check; says what it took out. */
export function readySignIn(home: string, say: (text: string) => void): void {
  for (const folder of Object.keys(SIGN_IN)) {
    mkdirSync(join(home, folder), { recursive: true, mode: 0o700 });
  }
  // Claude Code keeps its account file in its config folder when CLAUDE_CONFIG_DIR names it, as
  // the place does: one signed in before that has it in the home, where no run can mount it.
  const legacy = join(home, '.claude.json');
  const kept = join(home, '.claude', '.claude.json');
  if (existsSync(legacy) && !existsSync(kept)) renameSync(legacy, kept);
  const removed: string[] = [];
  for (const [folder, names] of Object.entries(SIGN_IN)) {
    for (const name of readdirSync(join(home, folder))) {
      const path = join(home, folder, name);
      // A sign-in file is a file: a link in its place would point a CLI's write somewhere else.
      if (names.includes(name) && lstatSync(path).isFile()) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(`~/${folder}/${name}`);
    }
  }
  if (existsSync(kept)) {
    const account = accountOnly(kept);
    if (account === undefined) {
      rmSync(kept, { force: true });
      removed.push('~/.claude/.claude.json');
    } else if (account !== readFileSync(kept, 'utf8')) {
      writeFileSync(kept, account, { mode: 0o600 });
      removed.push("~/.claude/.claude.json's settings other than the account");
    }
  }
  if (removed.length > 0) {
    say(`took out of the sign-in folders what is not the sign-in: ${removed.join(', ')}`);
  }
}
