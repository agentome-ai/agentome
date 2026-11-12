import {
  Check,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../api';
import { httpUrl } from '../runs/run-data';
import { cn } from '../ui/cn';
import type { Task } from './tasks-data';

// What a task changed, as the task page's Changes shows it.
export type TaskChanges = {
  branches: {
    name: string;
    commits: { sha: string; subject: string }[];
    additions: number | null;
    deletions: number | null;
    files: number | null;
    url: string | null;
  }[];
  changeRequests: {
    url: string;
    number: number | null;
    title: string | null;
    state: 'open' | 'draft' | 'merged' | 'closed' | null;
    pipeline: 'none' | 'running' | 'success' | 'failed' | null;
  }[];
  problem: string | null;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const tile = 'grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-paper';
const card = 'rounded-xl border border-line bg-raised';

export type Request = TaskChanges['changeRequests'][number] & {
  review?: Task['changeRequests'][number]['review'];
};
type Branch = TaskChanges['branches'][number] & {
  /** The repository it went to, when the card stands outside its task. */
  where?: string;
};

/**
 * The branches the task's runs left and its change requests. What Agentome recorded shows at
 * once; the size of each branch and each change request's title, state and CI come from the
 * code host, asked again when a run of the task ends.
 */
export function TaskChangesSection({ task }: { task: Task }) {
  const [changes, setChanges] = useState<TaskChanges>();
  const ended = task.runs.filter((run) => run.endedAt).length;
  useEffect(() => {
    let current = true;
    api<TaskChanges>(`/api/tasks/${task.id}/changes`).then(
      (loaded) => current && setChanges(loaded),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [task.id, ended, task.changeRequests.length]);

  // The host's answer has the title; the review is what Agentome last heard of it.
  const reviews = new Map(task.changeRequests.map((request) => [request.url, request.review]));
  const requests: Request[] = (
    changes?.changeRequests ??
    task.changeRequests.map((request) => ({ ...request, number: null, title: null }))
  ).map((request) => ({ ...request, review: reviews.get(request.url) ?? null }));
  const branches = changes?.branches ?? [];
  if (branches.length === 0 && requests.length === 0) return null;
  return (
    <section aria-labelledby="changes" className="mt-10">
      <h2 id="changes" className="mb-3 text-section">
        Changes
      </h2>
      {/* Each a card, as Linear shows an issue's pull request: the change request
          first, with its state and CI in colour, then the branch with its size. */}
      {/* minmax(0, …): a long address or branch name truncates instead of widening the page. */}
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
        {requests.map((request) => (
          <RequestCard key={request.url} request={request} />
        ))}
        {branches.map((branch) => (
          <BranchCard key={branch.name} branch={branch} />
        ))}
      </ul>
      {changes?.problem && <p className="mt-3 text-small text-ink-3">{changes.problem}</p>}
    </section>
  );
}

/** A state in its colour: the word beside its icon on a tint of the colour. */
export function Pill({
  className,
  icon,
  children,
}: {
  className: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-current/25 bg-current/8 px-2 text-small font-medium',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

const icon = 'size-3.5';
const states = {
  merged: [GitMerge, 'text-done', 'Merged'],
  closed: [GitPullRequestClosed, 'text-ink-3', 'Closed'],
  draft: [GitPullRequest, 'text-ink-2', 'Draft'],
  open: [GitPullRequest, 'text-review', 'Open'],
} as const;

function pipelinePill(pipeline: Request['pipeline']) {
  if (pipeline === 'success')
    return (
      <Pill className="text-review" icon={<Check aria-hidden="true" className={icon} />}>
        CI passed
      </Pill>
    );
  if (pipeline === 'failed')
    return (
      <Pill className="text-failed" icon={<X aria-hidden="true" className={icon} />}>
        CI failed
      </Pill>
    );
  if (pipeline === 'running')
    return (
      <Pill className="text-waiting" icon={<CircleDashed aria-hidden="true" className={icon} />}>
        CI running
      </Pill>
    );
  return null;
}

function reviewPill(review: Request['review']) {
  if (review === 'approved') return <Pill className="text-review">Approved</Pill>;
  if (review === 'changes_requested')
    return <Pill className="text-waiting">Changes requested</Pill>;
  return null;
}

/** "web-elm !306", "api #7": the repository and the number, as its host writes it. */
function whereOf(request: Request) {
  const gitlab = /\/([^/]+)\/-\/merge_requests\/(\d+)/.exec(request.url);
  if (gitlab) return `${gitlab[1]} !${gitlab[2]}`;
  const github = /\/([^/]+)\/pull\/(\d+)/.exec(request.url);
  if (github) return `${github[1]} #${github[2]}`;
  return request.number !== null ? `#${request.number}` : request.url;
}

/** `stacked`: in a narrow column, the states go under the name at every width. */
export function RequestCard({ request, stacked }: { request: Request; stacked?: boolean }) {
  const href = httpUrl(request.url);
  const [Icon, color, word] = states[request.state ?? 'open'];
  const where = whereOf(request);
  const content = (
    <>
      <span className={tile}>
        <Icon aria-hidden="true" className={cn('size-4', color)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">{request.title ?? where}</span>
        <span className="block truncate font-mono text-[12px] leading-5 text-ink-2">
          {request.title ? where : request.url}
        </span>
      </span>
      {/* On a phone the states go under the name, the whole card still one link. */}
      <span
        className={cn(
          'flex flex-wrap gap-1.5',
          stacked
            ? 'order-last basis-full pl-12 empty:hidden'
            : 'max-md:order-last max-md:basis-full max-md:pl-12',
        )}
      >
        {request.state && request.state !== 'open' && <Pill className={color}>{word}</Pill>}
        {pipelinePill(request.pipeline)}
        {reviewPill(request.review)}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn('size-4 shrink-0 text-ink-3', stacked ? 'hidden' : 'max-md:hidden')}
      />
    </>
  );
  const row = 'flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3';
  return (
    <li className={card}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={cn(row, 'rounded-xl hover:bg-hover')}
        >
          {content}
        </a>
      ) : (
        <div className={row}>{content}</div>
      )}
    </li>
  );
}

/** `pushed` false: commits a run made that no repository kept (`pushedTo`). */
export function BranchCard({ branch, pushed = true }: { branch: Branch; pushed?: boolean }) {
  const [open, setOpen] = useState(false);
  const href = branch.url ? httpUrl(branch.url) : null;
  const facts = [
    branch.commits.length > 0 && (
      <span key="commits">{plural(branch.commits.length, 'commit')}</span>
    ),
    branch.additions !== null && (
      <span key="size" className="font-mono">
        <span className="text-review">+{branch.additions}</span>{' '}
        <span className="text-failed">−{branch.deletions}</span>
      </span>
    ),
    branch.files !== null && <span key="files">{plural(branch.files, 'file')}</span>,
    branch.where && (
      <span key="where" className="min-w-0 truncate">
        {branch.where}
      </span>
    ),
  ].filter(Boolean);
  const head = (
    <>
      <span className={tile}>
        <GitBranch aria-hidden="true" className="size-4 text-ink-2" />
      </span>
      <span className="min-w-0 flex-1">
        {/* Commits no repository kept name no branch: none by that name exists anywhere. */}
        {pushed ? (
          <code className="block truncate text-[13px] text-ink">{branch.name}</code>
        ) : (
          <span className="block font-medium text-ink">Commits</span>
        )}
        <span className="flex flex-wrap gap-x-1.5 text-small text-ink-2">
          {facts.map((fact, index) => (
            <span key={index} className="flex min-w-0 gap-1.5">
              {index > 0 && <span aria-hidden="true">·</span>}
              {fact}
            </span>
          ))}
        </span>
      </span>
      {/* Where it went says it was pushed; in a narrow column the facts keep the room. */}
      {(!pushed || !branch.where) && (
        <Pill className={pushed ? 'text-ink-2' : 'text-ink-3'}>
          {pushed ? 'Pushed' : 'Not pushed'}
        </Pill>
      )}
    </>
  );
  const row = 'flex w-full items-center gap-3 px-3.5 py-3 text-left';
  if (branch.commits.length === 0) {
    return (
      <li className={card}>
        <div className={row}>{head}</div>
      </li>
    );
  }
  return (
    <li className={card}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cn(row, 'rounded-xl hover:bg-hover')}
      >
        {head}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-ink-3 transition-transform duration-120',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && (
        <div className="grid gap-2 border-t border-line px-3.5 py-3 sm:pl-15.5">
          <ol className="grid gap-1 text-small">
            {branch.commits.map((commit) => (
              <li key={commit.sha} className="flex min-w-0 gap-2.5">
                <code className="shrink-0 text-running">{commit.sha.slice(0, 7)}</code>
                <span className="truncate text-ink">{commit.subject}</span>
              </li>
            ))}
          </ol>
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-max items-center gap-1 text-small text-ink-2 underline underline-offset-2 hover:text-ink"
            >
              Compare on the code host
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}
