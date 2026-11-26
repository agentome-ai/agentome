import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchPackage } from '../test/fake-server.js';
import { digestOf, skillFilesFor } from './skill-files.js';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const wire = [
  { path: 'references/a.md', content: b64('A') },
  { path: 'scripts/run.py', content: b64('print(1)\n') },
];
// The server's digest of these files: apps/server/test/skills.test.ts holds the same.
const digest = 'b0424fbafea09642a588e494b371af8098149eb26e60f33f000091bd20313e58';
const skillId = '7d3c2b1a-0000-4000-8000-000000000001';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentome-skill-files-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function withSkill(files = { skillId, count: 2, digest }) {
  const launch = launchPackage({});
  launch.agent.skills = [{ name: 'sr-docs', version: 1, content: '---\n---\n', files }];
  return launch;
}

describe("a skill's files", () => {
  it('are digested as the server digests them', () => {
    const files = wire.map(({ path, content }) => ({
      path,
      content: Buffer.from(content, 'base64'),
    }));
    expect(digestOf(files)).toBe(digest);
    expect(digestOf([...files].reverse())).toBe(digest);
  });

  it('are fetched once per version and kept; kept ones that changed are fetched again', async () => {
    const fetchFiles = vi.fn(async () => wire);
    const first = await skillFilesFor(home, withSkill(), fetchFiles);
    expect(first.get(skillId)?.map(({ path }) => path)).toEqual([
      'references/a.md',
      'scripts/run.py',
    ]);
    await skillFilesFor(home, withSkill(), fetchFiles);
    expect(fetchFiles).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(home, 'skill-files'))).toEqual([`${digest}.json`]);

    writeFileSync(join(home, 'skill-files', `${digest}.json`), JSON.stringify([wire[0]]));
    await skillFilesFor(home, withSkill(), fetchFiles);
    expect(fetchFiles).toHaveBeenCalledTimes(2);
  });

  it('are refused when they are not what the launch package said, or a path is out of shape', async () => {
    await expect(
      skillFilesFor(
        home,
        withSkill({ skillId, count: 2, digest: 'f'.repeat(64) }),
        async () => wire,
      ),
    ).rejects.toThrow(/do not match its launch package/);
    await expect(
      skillFilesFor(home, withSkill(), async () => [{ path: '.git/config', content: b64('x') }]),
    ).rejects.toThrow(/path out of shape/);
    await expect(
      skillFilesFor(home, withSkill({ skillId, count: 2, digest: '../x' }), async () => wire),
    ).rejects.toThrow(/digest out of shape/);
  });

  it('are not fetched for a skill without any', async () => {
    const launch = launchPackage({});
    launch.agent.skills = [{ name: 'plain', version: 1, content: '---\n---\n' }];
    const fetchFiles = vi.fn(async () => wire);
    expect((await skillFilesFor(home, launch, fetchFiles)).size).toBe(0);
    expect(fetchFiles).not.toHaveBeenCalled();
  });
});
