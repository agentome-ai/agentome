import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '@agentome/db';
import { deriveKey } from '../auth.js';
import { connectionFor } from '../connections/service.js';

// The run's password for the git proxy: not the run token, which the agent must not
// read, because its git runs in its sandbox and so can read whatever password git knows. This
// one opens the proxy only, for the run's own repository, while the run is live.

export function gitPassword(secretKey: string, runId: string): string {
  return createHmac('sha256', deriveKey(secretKey, 'git')).update(runId).digest('base64url');
}

export function isGitPassword(secretKey: string, runId: string, password: string): boolean {
  const [expected, given] = [Buffer.from(gitPassword(secretKey, runId)), Buffer.from(password)];
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** `owner/name` or `group/sub/name`: the path of a repository's URL, as hosts and git take it. */
export function repositoryPath(url: string): string {
  return new URL(url).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}

/** Where the run's git goes and how it signs in: nothing for a repository nobody connected. */
export async function gitAccess(
  db: Db,
  input: {
    runId: string;
    agentId: string;
    repository: string | null;
    publicUrl: string;
    secretKey: string;
  },
) {
  const connection = await connectionFor(db, input.agentId, input.repository);
  if (!connection || input.repository === null) return undefined;
  return {
    url: `${input.publicUrl.replace(/\/+$/, '')}/git/${repositoryPath(input.repository)}.git`,
    username: input.runId,
    password: gitPassword(input.secretKey, input.runId),
  };
}
