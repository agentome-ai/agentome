import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SKILL_FILES, skillFilePath } from '@agentome/shared';
import type { LaunchPackage } from './client.js';

// The files a skill brings beside its SKILL.md: fetched once per version with what
// reports the run, kept by their digest under the worker's home, and laid out with the profile.

export type SkillFile = { path: string; content: Buffer };
type Marker = NonNullable<NonNullable<LaunchPackage['agent']['skills']>[number]['files']>;
/** Fetches a skill's files from the server, in base64 as the wire carries them. */
export type FetchFiles = (skillId: string) => Promise<{ path: string; content: string }[]>;

/** A kept version nobody's run used for this long goes at the next fetch. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const DIGEST = /^[0-9a-f]{64}$/;

/** The server's digest of a version's files: their paths and bytes in path order. */
export function digestOf(files: SkillFile[]): string {
  const digest = createHash('sha256');
  for (const { path, content } of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    digest.update(`${path}\0${content.length}\0`).update(content);
  }
  return digest.digest('hex');
}

/** The files as the server sent them, refused unless they are what the launch package said. */
function checked(files: { path: string; content: string }[], marker: Marker): SkillFile[] {
  const decoded = files.map(({ path, content }) => ({
    path,
    content: Buffer.from(content, 'base64'),
  }));
  const strange = decoded.find(({ path }) => !skillFilePath(path));
  if (strange) throw new Error(`The server sent a skill file path out of shape: ${strange.path}`);
  const bytes = decoded.reduce((sum, { content }) => sum + content.length, 0);
  if (decoded.length > SKILL_FILES.count || bytes > SKILL_FILES.bytes)
    throw new Error("The server sent more of a skill's files than a skill may have");
  if (decoded.length !== marker.count || digestOf(decoded) !== marker.digest)
    throw new Error("The server sent a skill's files that do not match its launch package");
  return decoded;
}

function kept(dir: string, marker: Marker): SkillFile[] | undefined {
  const file = join(dir, `${marker.digest}.json`);
  try {
    const files = checked(JSON.parse(readFileSync(file, 'utf8')) as never, marker);
    const now = new Date();
    utimesSync(file, now, now);
    return files;
  } catch {
    // Missing, or no longer what its name says: fetched again.
    rmSync(file, { force: true });
    return undefined;
  }
}

function keep(dir: string, marker: Marker, files: { path: string; content: string }[]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (Date.now() - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
  }
  // Written aside, then moved: a run that stops halfway leaves no file of half the files.
  const partial = join(dir, `${marker.digest}.${process.pid}.partial`);
  writeFileSync(partial, JSON.stringify(files), { mode: 0o600 });
  renameSync(partial, join(dir, `${marker.digest}.json`));
}

/**
 * The files of every skill of the run, its team's members' included, by skill version: from
 * what this worker keeps, or else from the server.
 */
export async function skillFilesFor(
  home: string,
  launch: LaunchPackage,
  fetchFiles: FetchFiles,
): Promise<Map<string, SkillFile[]>> {
  const markers = [
    ...(launch.agent.skills ?? []),
    ...(launch.team?.members.flatMap((member) => member.skills) ?? []),
  ].flatMap((skill) => (skill.files ? [skill.files] : []));
  const dir = join(home, 'skill-files');
  const found = new Map<string, SkillFile[]>();
  for (const marker of markers) {
    if (found.has(marker.skillId)) continue;
    if (!DIGEST.test(marker.digest))
      throw new Error(`The server sent a skill files digest out of shape: ${marker.digest}`);
    const have = kept(dir, marker);
    if (have) {
      found.set(marker.skillId, have);
      continue;
    }
    const files = await fetchFiles(marker.skillId);
    found.set(marker.skillId, checked(files, marker));
    keep(dir, marker, files);
  }
  return found;
}
