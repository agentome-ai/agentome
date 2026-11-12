import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { type ApiError, api, asApiError } from '../api';

// The approvals API as the pages read it.

export type Approval = {
  id: string;
  tool: string;
  input: unknown;
  runId: string;
  agent: { id: string; name: string };
  task: { id: string; title: string; repository: string | null } | null;
  createdAt: string;
};

type ApprovalsState = {
  /** Undefined until the first answer. */
  approvals: Approval[] | undefined;
  error: ApiError | undefined;
  reload: () => Promise<void>;
};
const ApprovalsContext = createContext<ApprovalsState | null>(null);

// A waiting call holds its run, so the count asks every 5 s while the tab is in view, and at
// once when the person comes back to it: at 30 s a new request seemed to need a reload.
const REFRESH_MS = 5_000;

/** The calls waiting for the person, for the sidebar's count and the Approvals page alike. */
export function ApprovalsProvider({ children }: { children: ReactNode }) {
  const [approvals, setApprovals] = useState<Approval[]>();
  const [error, setError] = useState<ApiError>();
  const reload = useCallback(
    () =>
      api<{ approvals: Approval[] }>('/api/approvals').then(
        (data) => {
          setApprovals(data.approvals);
          setError(undefined);
        },
        // The list stays as it was: a failed poll should not empty the queue under the cursor.
        (caught: unknown) => setError(asApiError(caught)),
      ),
    [],
  );
  useEffect(() => {
    void reload();
    const tick = () => document.visibilityState === 'visible' && void reload();
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reload]);
  return <ApprovalsContext value={{ approvals, error, reload }}>{children}</ApprovalsContext>;
}

export function useApprovals(): ApprovalsState {
  const state = useContext(ApprovalsContext);
  if (!state) throw new Error('useApprovals needs an ApprovalsProvider above it');
  return state;
}

/** acme/api from https://github.com/acme/api.git; the address as it is otherwise. */
export function repositoryName(url: string): string {
  const match = /^(?:https?:\/\/[^/]+\/|git@[^:]+:)(.+?)(?:\.git)?\/?$/.exec(url);
  return match?.[1] ?? url;
}

/** What GitHub and GitLab call the change request a call opens. */
function changeRequestWord(repository: string | null | undefined): string {
  if (repository && /gitlab/i.test(repository)) return 'merge request';
  if (repository && /github/i.test(repository)) return 'pull request';
  return 'change request';
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * A call in people's words: what the agent wants to do, and what it wrote that goes with it
 * (a change request's title and description, a reply), which the page shows as its own words.
 */
export function describe(call: Pick<Approval, 'tool' | 'input' | 'task'>): {
  action: string;
  /** The names in `action` one would paste into a terminal: repositories and branches. */
  refs: string[];
  title?: string;
  body?: string;
} {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const repository = call.task?.repository;
  const name = repository ? repositoryName(repository) : undefined;
  const number = typeof input.number === 'number' ? `#${input.number}` : 'a change request';
  const branch = text(input.branch) ?? 'a branch';
  const refs = [name, text(input.branch), text(input.target), text(input.from)].filter(
    (ref): ref is string => ref !== undefined,
  );
  switch (call.tool) {
    // A question to the owner: the question is what the row says.
    case 'ask_owner':
      return { refs: [], action: `Asks: ${text(input.question) ?? 'a question'}` };
    case 'code_host_open_change_request': {
      const draft = input.draft === true ? 'draft ' : '';
      const target = text(input.target) ? ` into ${text(input.target)}` : '';
      return {
        refs,
        action: `Open a ${draft}${changeRequestWord(repository)}${name ? ` to ${name}` : ''} from ${branch}${target}`,
        title: text(input.title),
        body: text(input.description),
      };
    }
    case 'code_host_create_branch':
      return {
        refs,
        action: `Create the branch ${branch}${name ? ` in ${name}` : ''} from ${text(input.from) ?? 'the default branch'}`,
      };
    case 'code_host_reply_to_review':
      return { refs, action: `Reply on ${number}`, body: text(input.body) };
    case 'code_host_get_change_request':
      return { refs, action: `Read ${number}` };
    case 'code_host_get_pipeline_failures':
      return { refs, action: `Read the pipeline failures of ${number}` };
    case 'team_step': {
      // A team lead's assignment: a manual step, or in auto the one approval of the
      // task, after the first assignment: the run shows what that one found.
      const names = Array.isArray(input.members)
        ? input.members.map((member: unknown) => text((member as { name?: unknown })?.name) ?? '?')
        : [];
      const who = names.join(', ') || 'its team';
      const step = typeof input.step === 'number' ? input.step : undefined;
      return {
        refs: [],
        action: step
          ? `Start step ${step}: ${who}`
          : input.gate === true
            ? `Go on after the first step: ${who} next`
            : `Give work to ${who}`,
        body: text(input.description) || undefined,
      };
    }
    default:
      return { refs, action: `Use ${call.tool}`, body: JSON.stringify(call.input, null, 2) };
  }
}
