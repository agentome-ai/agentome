import { type Db, desc, eq, runArtifacts, runs } from '@agentome/db';
import { z } from 'zod';
import { CodeHostError } from '../code-host/errors.js';
import { codeHostOf, connectionFor } from '../connections/service.js';
import { taskView } from './service.js';

// What a task changed (the task page's Changes): the branches its runs left on the code host,
// with their commits as the runs recorded them, and its change requests, each asked of the
// host when the page opens, so the size of a branch and a change request's CI are today's.

/** The most commits a branch lists: the host has the rest. */
const COMMITS = 20;

const Commit = z.object({ sha: z.string(), subject: z.string() });
const BranchMeta = z.object({
  commits: z.array(Commit).catch([]),
  pushedTo: z.string().nullable().catch(null),
});
const RequestMeta = z.object({ number: z.number().int().optional() });
const State = z.enum(['open', 'draft', 'merged', 'closed']).nullable().catch(null);
const Pipeline = z.enum(['none', 'running', 'success', 'failed']).nullable().catch(null);

export const TaskChanges = z.object({
  branches: z.array(
    z.object({
      name: z.string(),
      commits: z.array(Commit),
      additions: z.number().int().nullable(),
      deletions: z.number().int().nullable(),
      files: z.number().int().nullable(),
      url: z.string().nullable(),
    }),
  ),
  changeRequests: z.array(
    z.object({
      url: z.string(),
      number: z.number().int().nullable(),
      title: z.string().nullable(),
      state: State,
      pipeline: Pipeline,
    }),
  ),
  /** Why the host could not be asked, when it could not: the rest is what Agentome recorded. */
  problem: z.string().nullable(),
});
export type TaskChanges = z.infer<typeof TaskChanges>;

export async function taskChanges(
  db: Db,
  key: Buffer,
  taskId: string,
  userId: string,
): Promise<TaskChanges> {
  const task = await taskView(db, taskId, userId);
  const artifacts = await db
    .select({ kind: runArtifacts.kind, ref: runArtifacts.ref, meta: runArtifacts.meta })
    .from(runArtifacts)
    .innerJoin(runs, eq(runs.id, runArtifacts.runId))
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runArtifacts.createdAt), desc(runArtifacts.id));

  // A branch on the host, newest run first; later runs on the same branch add their commits.
  const branches = new Map<string, z.infer<typeof Commit>[]>();
  for (const artifact of artifacts) {
    if (artifact.kind !== 'branch') continue;
    const meta = BranchMeta.parse(artifact.meta ?? {});
    if (!meta.pushedTo?.startsWith('http')) continue;
    const known = branches.get(artifact.ref) ?? [];
    const seen = new Set(known.map((commit) => commit.sha));
    branches.set(artifact.ref, [...known, ...meta.commits.filter((c) => !seen.has(c.sha))]);
  }
  const requests = artifacts
    .filter((artifact) => artifact.kind === 'change_request')
    .filter((artifact, index, all) => all.findIndex((a) => a.ref === artifact.ref) === index)
    .map((artifact) => ({
      url: artifact.ref,
      number: RequestMeta.parse(artifact.meta ?? {}).number ?? null,
      recorded: task.changeRequests.find((request) => request.url === artifact.ref),
    }));

  const recordedOnly = (problem: string | null): TaskChanges => ({
    branches: [...branches].map(([name, commits]) => ({
      name,
      commits: commits.slice(0, COMMITS),
      additions: null,
      deletions: null,
      files: null,
      url: null,
    })),
    changeRequests: requests.map(({ url, number, recorded }) => ({
      url,
      number,
      title: null,
      state: State.parse(recorded?.state ?? null),
      pipeline: Pipeline.parse(recorded?.pipeline ?? null),
    })),
    problem,
  });
  if (branches.size === 0 && requests.length === 0) return recordedOnly(null);

  const connection = await connectionFor(db, task.agent.id, task.repository);
  if (!task.repository || !connection) {
    return recordedOnly(
      task.repository
        ? "This task's repository is not under a code host connection of the agent's projects."
        : null,
    );
  }
  try {
    const host = await codeHostOf(db, key, connection.id);
    const repository = await host.repository(task.repository);
    const [sizes, fresh] = await Promise.all([
      Promise.allSettled(
        [...branches.keys()].map((name) =>
          host.compare(repository.path, repository.defaultBranch, name),
        ),
      ),
      Promise.allSettled(
        requests.map(({ number }) =>
          number === null
            ? Promise.reject(new Error('no number'))
            : host.getChangeRequest(repository.path, number),
        ),
      ),
    ]);
    const recorded = recordedOnly(null);
    return {
      branches: recorded.branches.map((branch, index) => {
        const size = sizes[index];
        return size?.status === 'fulfilled' ? { ...branch, ...size.value } : branch;
      }),
      changeRequests: recorded.changeRequests.map((request, index) => {
        const live = fresh[index];
        return live?.status === 'fulfilled'
          ? {
              ...request,
              title: live.value.title,
              state: live.value.state,
              pipeline: live.value.pipeline,
            }
          : request;
      }),
      problem: null,
    };
  } catch (error) {
    if (!(error instanceof CodeHostError)) throw error;
    return recordedOnly(`The code host did not answer: ${error.message}`);
  }
}
