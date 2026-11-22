import { parseAllDocuments } from 'yaml';

// Which files decide what a pipeline runs, read from the files themselves: the git proxy keeps
// an agent's push from changing them (git/routes.ts). The scripts a job calls are not among them:
// those are the project's code, which a pipeline runs whatever it is.

/** At most this many files are followed from a configuration; more and the proxy cannot tell. */
export const MAX_PIPELINE_FILES = 50;

/**
 * The files of this repository a GitLab CI file includes: those it names exactly, and the
 * wildcard patterns, for its own pipeline (`include`) and its child pipelines
 * (`trigger: include`). A variable in a path stands for any folders (`**`): an agent's branch
 * name could be its value. Other projects, remote files and templates are not the agent's to
 * change. `unreadable` when the file cannot be read for certain: YAML that does not parse, or an
 * include of this same project by `project` or `component`, which a ref of the agent's could
 * point at; the proxy refuses then.
 */
export function gitlabIncludes(
  text: string,
  repository: string,
): { paths: string[]; patterns: string[]; unreadable: boolean } {
  const paths = new Set<string>();
  const patterns = new Set<string>();
  let unreadable = false;
  const own = repository.toLowerCase();
  const add = (entry: unknown) => {
    // A variable ($CI_PROJECT_PATH, say) may name this same project: no telling which.
    if (isRecord(entry) && typeof entry.project === 'string') {
      const project = entry.project.replace(/^\/+|\/+$/g, '').toLowerCase();
      if (project === own || project.includes('$')) unreadable = true;
      return;
    }
    if (isRecord(entry) && typeof entry.component === 'string') {
      // The instance's own name stands at the front of most components: that one is known.
      const component = entry.component
        .toLowerCase()
        .replace(/^\$\{?ci_server_(fqdn|host)\}?\//, 'host/');
      if (component.includes(`/${own}/`) || component.includes('$')) unreadable = true;
      return;
    }
    // A file of this same project by its address, on a branch the agent may push to.
    const remote =
      typeof entry === 'string' && /^https?:\/\//i.test(entry)
        ? entry
        : isRecord(entry) && typeof entry.remote === 'string'
          ? entry.remote
          : undefined;
    if (remote !== undefined) {
      const path = decodeURIComponent(remote.replace(/^https?:\/\/[^/]+/i, '')).toLowerCase();
      if (path.startsWith(`/${own}/`) || path.includes('$')) unreadable = true;
      return;
    }
    // A child pipeline from a job's artifact: what the repository's code wrote, at run time.
    if (isRecord(entry) && entry.artifact !== undefined) {
      unreadable = true;
      return;
    }
    const local =
      typeof entry === 'string'
        ? entry
        : isRecord(entry) && typeof entry.local === 'string'
          ? entry.local
          : undefined;
    if (local === undefined) return;
    const path = local
      .trim()
      .replace(/^\/+/, '')
      .replace(/\$\[\[[^\]]*\]\]|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, '**');
    if (path === '') return;
    (path.includes('*') ? patterns : paths).add(path);
  };
  const addAll = (include: unknown) => {
    for (const entry of Array.isArray(include) ? include : [include]) add(entry);
  };
  // Every document: a file that takes inputs has its `spec` in the first and its jobs after it.
  for (const document of parseAllDocuments(text, { uniqueKeys: false })) {
    if (document.errors.length > 0) return { paths: [], patterns: [], unreadable: true };
    let config: unknown;
    try {
      // A person wrote these on the default branch: a large file may use an anchor many times.
      config = document.toJS({ maxAliasCount: -1 });
    } catch {
      return { paths: [], patterns: [], unreadable: true };
    }
    if (!isRecord(config)) continue;
    addAll(config.include);
    for (const job of Object.values(config)) {
      if (isRecord(job) && isRecord(job.trigger)) addAll(job.trigger.include);
    }
  }
  return { paths: [...paths], patterns: [...patterns], unreadable };
}

/** The folders of the local actions a GitHub workflow or action uses: `uses: ./tools/deploy`. */
export function localActions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\buses:\s*["']?\.\/([^\s"'#]*)/g)) {
    found.add((match[1] ?? '').replace(/\/+$/, ''));
  }
  return [...found];
}

/** The definition files of a local action in a folder; the repository's root is ''. */
export const actionFiles = (folder: string) =>
  ['action.yml', 'action.yaml'].map((name) => (folder ? `${folder}/${name}` : name));

/** A GitLab include pattern as a test of a path: `*` within a folder, `**` across folders. */
export function globTest(pattern: string): (path: string) => boolean {
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  const regex = new RegExp(`^${source}$`);
  return (path) => regex.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
