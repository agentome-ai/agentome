/** What a skill's files may come to: one documentation skill we know is 924 files, 7.6 MB. */
export const SKILL_FILES = { count: 3_000, bytes: 25 * 1024 * 1024, file: 5 * 1024 * 1024 };

/**
 * A file's path in its skill's folder: relative, of plain segments. No `..` or hidden segment
 * (`.git`, `.env`), no backslash, which Windows reads as a separator, and not the skill's own
 * SKILL.md. The server takes no other, and a worker lays out no other.
 */
export function skillFilePath(path: string): boolean {
  if (path === 'SKILL.md' || path.length > 512 || /[\\\p{Cc}]/u.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && !segment.startsWith('.'));
}
