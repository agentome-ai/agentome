import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// The person's sign-in to the CLIs in their place, which each run's container mounts:
// `~/.claude` and `~/.codex` of the place's home. A run may write there, since the CLIs refresh
// their tokens there; so before each run the place takes out what is not the sign-in and would
// be read as instructions by the next run of any of the person's agents. The sign-in files
// themselves are left as they are, never read.

/** What of the CLIs' folders a run could leave for the next one to follow. */
const NOT_THE_SIGN_IN = {
  '.claude': [
    'skills',
    'agents',
    'commands',
    'plugins',
    'hooks',
    'output-styles',
    'settings.json',
    'settings.local.json',
    'CLAUDE.md',
    'CLAUDE.local.md',
  ],
  '.codex': ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'prompts', 'skills', 'rules'],
};

/** Makes the sign-in folders ready for a run's container; says what it took out. */
export function readySignIn(home: string, say: (text: string) => void): void {
  for (const folder of Object.keys(NOT_THE_SIGN_IN)) {
    mkdirSync(join(home, folder), { recursive: true, mode: 0o700 });
  }
  // Claude Code keeps its account file in its config folder when CLAUDE_CONFIG_DIR names it, as
  // the place does: one signed in before that has it in the home, where no run can mount it.
  const legacy = join(home, '.claude.json');
  const kept = join(home, '.claude', '.claude.json');
  if (existsSync(legacy) && !existsSync(kept)) renameSync(legacy, kept);
  const removed: string[] = [];
  for (const [folder, names] of Object.entries(NOT_THE_SIGN_IN)) {
    for (const name of names) {
      const path = join(home, folder, name);
      if (!existsSync(path)) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(`~/${folder}/${name}`);
    }
  }
  if (removed.length > 0) {
    say(`took out of the sign-in folders what a run left there: ${removed.join(', ')}`);
  }
  // Claude Code's lock while it refreshes its token. With the token expired, `claude auth
  // status`, the place's check of the sign-in each minute, leaves it behind without refreshing,
  // and a run's CLI that finds it fails ("another Claude Code process is refreshing it"): so the
  // place never ran again until the token was refreshed by hand. Before a run no other Claude
  // Code of the place's is working, so a lock here is a leftover.
  const lock = join(home, '.claude', '.oauth_refresh.lock');
  if (existsSync(lock)) {
    rmSync(lock, { recursive: true, force: true });
    say("took out Claude Code's lock on refreshing its sign-in, which a check left");
  }
}
