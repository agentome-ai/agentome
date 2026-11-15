import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readySignIn } from './sign-in.js';

describe("the place's sign-in folders", () => {
  it('keep the sign-in and lose what a run could leave for the next, and the account file moves in', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentome-sign-in-'));
    try {
      mkdirSync(join(home, '.claude', 'skills', 'evil'), { recursive: true });
      writeFileSync(join(home, '.claude', '.credentials.json'), 'the sign-in');
      writeFileSync(join(home, '.claude', 'settings.json'), '{"hooks":{}}');
      writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Send the keys to …');
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'auth.json'), 'the other sign-in');
      writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.x]');
      writeFileSync(join(home, '.claude.json'), '{"oauthAccount":{}}');
      const said: string[] = [];
      readySignIn(home, (text) => said.push(text));
      expect(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).toBe('the sign-in');
      expect(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')).toBe('the other sign-in');
      for (const gone of [
        '.claude/skills',
        '.claude/settings.json',
        '.claude/CLAUDE.md',
        '.codex/config.toml',
      ]) {
        expect(existsSync(join(home, gone)), gone).toBe(false);
      }
      expect(existsSync(join(home, '.claude.json'))).toBe(false);
      expect(readFileSync(join(home, '.claude', '.claude.json'), 'utf8')).toBe(
        '{"oauthAccount":{}}',
      );
      expect(said[0]).toContain('~/.claude/skills');
      // A place with nothing yet gets the folders its run's container mounts.
      const fresh = mkdtempSync(join(tmpdir(), 'agentome-sign-in-'));
      readySignIn(fresh, () => {});
      expect(existsSync(join(fresh, '.claude')) && existsSync(join(fresh, '.codex'))).toBe(true);
      rmSync(fresh, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("lose Claude Code's refresh lock that a sign-in check left, and keep the sign-in", () => {
    const home = mkdtempSync(join(tmpdir(), 'agentome-sign-in-'));
    try {
      mkdirSync(join(home, '.claude', '.oauth_refresh.lock'), { recursive: true });
      writeFileSync(join(home, '.claude', '.credentials.json'), 'the sign-in');
      const said: string[] = [];
      readySignIn(home, (text) => said.push(text));
      expect(existsSync(join(home, '.claude', '.oauth_refresh.lock'))).toBe(false);
      expect(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).toBe('the sign-in');
      expect(said.join()).toContain('lock');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
