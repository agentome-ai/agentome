import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { api, asApiError } from '../api';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import type { ProjectView } from './projects-data';

// What the project's code hosts start by themselves: its webhooks already arrive; these
// say what they do. Off until someone switches them on, since each one spends a run.

type Changes = { onPipelineFailed?: boolean; onReview?: boolean; reviewerAgentId?: string | null };

export function Triggers(props: {
  project: ProjectView;
  canEdit: boolean;
  onSaved: (project: ProjectView) => void;
}) {
  const { project, canEdit } = props;
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!canEdit) return;
    api<{ agents: { id: string; name: string }[] }>('/api/agents').then(
      (data) => setAgents(data.agents),
      () => setAgents([]),
    );
  }, [canEdit]);

  async function change(changes: Changes) {
    try {
      props.onSaved(
        await api<ProjectView>(`/api/projects/${project.id}`, { method: 'PATCH', body: changes }),
      );
    } catch (caught) {
      toast.error("Couldn't change what the project starts", {
        description: asApiError(caught).message,
      });
    }
  }

  const { triggers } = project;
  const reviewers =
    triggers.reviewer && !agents.some((agent) => agent.id === triggers.reviewer?.id)
      ? [...agents, triggers.reviewer]
      : agents;
  return (
    <section aria-labelledby="triggers" className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex min-h-7 items-center">
        <h2 id="triggers" className="text-section">
          When something happens
        </h2>
      </div>
      <p className="-mt-1 text-small text-ink-3">
        Started by the code host&apos;s webhooks, at most three times a day for one task, and within
        the budgets.
      </p>
      <div className="divide-y divide-line rounded-lg border border-line">
        <Toggle
          label="Fix failed pipelines"
          note="When the pipeline of an agent's change request fails, the agent runs its task again to fix it."
          checked={triggers.onPipelineFailed}
          disabled={!canEdit}
          onChange={(on) => void change({ onPipelineFailed: on })}
        />
        <Toggle
          label="Address review comments"
          note="When someone asks for changes on an agent's change request, or comments on it, the agent runs its task again."
          checked={triggers.onReview}
          disabled={!canEdit}
          onChange={(on) => void change({ onReview: on })}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span id="reviewer" className="font-medium">
              Review people&apos;s change requests
            </span>
            <span className="text-small text-ink-3">
              A change request a person opens becomes a review task for this agent, run at once.
            </span>
          </div>
          {/* Who may not change it reads it. */}
          {!canEdit ? (
            <span className={triggers.reviewer ? '' : 'text-ink-3'}>
              {triggers.reviewer?.name ?? 'Nobody'}
            </span>
          ) : (
            <Select
              value={triggers.reviewer?.id ?? 'none'}
              disabled={!canEdit}
              onValueChange={(value) =>
                void change({ reviewerAgentId: value === 'none' ? null : value })
              }
            >
              <SelectTrigger aria-labelledby="reviewer" className="w-60 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nobody</SelectItem>
                {reviewers.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </section>
  );
}

function Toggle(props: {
  label: string;
  note: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <label htmlFor={id} className="font-medium">
          {props.label}
        </label>
        <span id={`${id}-note`} className="text-small text-ink-3">
          {props.note}
        </span>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-note`}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
        className="mt-0.5"
      />
    </div>
  );
}
