import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canaryMain, canaryVerdict } from './canary.js';

// The worker's check before a Codex run in a place, with the stand-in for Codex, which asks the
// check's model as Codex does and runs the command it is given here.

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

describe("Codex's check before a run in a place", () => {
  it('passes a command that ran in the sandbox and saw no sign-in, and nothing else', () => {
    expect(canaryVerdict('CANARY-HANDS\nCANARY-SEALED\n')).toBeUndefined();
    expect(canaryVerdict('CANARY-BRAIN\nCANARY-SEALED\n')).toMatch(/beside the person's sign-in/);
    expect(canaryVerdict('CANARY-HANDS\nCANARY-LEAK\n')).toMatch(/beside the person's sign-in/);
    expect(canaryVerdict('')).toBe('Codex ran no command at all');
    expect(canaryVerdict('unknown tool exec_command')).toBe('Codex ran no command in the sandbox');
  });

  it('asks the model as Codex does, and fails a Codex that ran its command in its own container', async () => {
    expect(await canaryMain(['ws://127.0.0.1:7422', FAKE], { PATH: process.env.PATH })).toBe(0);
    expect(
      await canaryMain(['ws://127.0.0.1:7422', FAKE], {
        PATH: process.env.PATH,
        CODEX_FAKE_CANARY: 'brain',
      }),
    ).toBe(1);
    expect(await canaryMain([], { PATH: process.env.PATH })).toBe(2);
  }, 30_000);
});
