import { SKILL_FILES, skillFilePath } from '@agentome/shared';

// A skill's folder as the browser reads it: its SKILL.md, and the files beside it with
// their paths in the folder. Checked against the server's limits before anything is sent.

export type SkillFolder = {
  /** The folder's own SKILL.md, when it has one. */
  skillMd?: string;
  files: { path: string; file: File }[];
  bytes: number;
  /** Hidden files and folders, such as .git or .DS_Store, which a skill does not take. */
  hidden: number;
};

/** Sizes as people read them: 7.6 MB, 340 KB. */
export function sizeOf(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export const filesOf = (count: number, bytes: number) =>
  `${count.toLocaleString('en')} ${count === 1 ? 'file' : 'files'}, ${sizeOf(bytes)}`;

/** The folder picked, or what keeps a skill from taking it. */
export async function readFolder(picked: File[]): Promise<SkillFolder | { error: string }> {
  const folder: SkillFolder = { files: [], bytes: 0, hidden: 0 };
  for (const file of picked) {
    // The picked folder's own name comes first: the skill's paths start inside it.
    const path = (file.webkitRelativePath || file.name).split('/').slice(1).join('/');
    if (path.split('/').some((segment) => segment.startsWith('.'))) {
      folder.hidden += 1;
      continue;
    }
    if (path === 'SKILL.md') {
      folder.skillMd = await file.text();
      continue;
    }
    if (!skillFilePath(path)) return { error: `${path} has a name a skill file cannot have.` };
    if (file.size > SKILL_FILES.file)
      return { error: `${path} is ${sizeOf(file.size)}. A file of a skill may be 5 MB at most.` };
    folder.files.push({ path, file });
    folder.bytes += file.size;
  }
  if (folder.files.length > SKILL_FILES.count)
    return {
      error: `The folder has ${folder.files.length} files. A skill may have 3,000 at most.`,
    };
  if (folder.bytes > SKILL_FILES.bytes)
    return { error: `The folder's files come to ${sizeOf(folder.bytes)}. A skill may have 25 MB.` };
  return folder;
}

/** The files as the server takes them: their bytes in base64. */
export async function encodeFiles(folder: SkillFolder) {
  return Promise.all(
    folder.files.map(async ({ path, file }) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      // In pieces: one call with millions of arguments would overflow the stack.
      for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      }
      return { path, content: btoa(binary) };
    }),
  );
}
