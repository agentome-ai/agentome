import { ArrowLeft, Ellipsis } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { split } from '../shell/page-header';
import { AgentTile } from '../ui/tint';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as M from '../ui/dropdown-menu';

// What the library's two panes share: a skill and a server read the same way, a name with what
// can be done to it, a line about it, then the thing itself.

/**
 * The picked item's side of the library: its header, the item itself under it, and beside them
 * what is known about it (from 1800 px a column of its own, see `split`).
 */
export function Pane(props: {
  label: string;
  onBack: () => void;
  header?: ReactNode;
  context?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article aria-label={props.label} className={split.body}>
      <div className={split.column}>
        {/* A phone shows the list or the item, never both. */}
        <button
          type="button"
          onClick={props.onBack}
          className="-ml-1 inline-flex items-center gap-1 justify-self-start text-read text-ink-2 md:hidden"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Library
        </button>
        {props.header}
      </div>
      {props.context && (
        <aside aria-label={`About ${props.label}`} className={split.context}>
          {props.context}
        </aside>
      )}
      <div className={split.column}>{props.children}</div>
    </article>
  );
}

/**
 * Which of the person's agents have the item: the one thing about a skill or a server
 * that no page said. `from` names where an agent is given one.
 */
export function UsedBy(props: { url: string; from: string }) {
  const [agents, setAgents] = useState<{ id: string; name: string }[] | 'failed'>();
  useEffect(() => {
    let current = true;
    api<{ agents: { id: string; name: string }[] }>(props.url).then(
      (answer) => current && setAgents(answer.agents),
      () => current && setAgents('failed'),
    );
    return () => {
      current = false;
    };
  }, [props.url]);
  return (
    <section aria-labelledby="used-by" className="grid gap-2">
      <h3 id="used-by" className="text-section">
        Used by
      </h3>
      {agents === 'failed' ? (
        <p className="text-ink-3">Couldn't load the agents that have it.</p>
      ) : agents?.length === 0 ? (
        <p className="text-ink-3">None of your agents yet. Give it to one from {props.from}.</p>
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
          {agents?.map((agent) => (
            <li key={agent.id} className="min-w-0">
              <Link
                to={`/agents/${agent.id}`}
                className="inline-flex max-w-full items-center gap-2"
              >
                <AgentTile id={agent.id} name={agent.name} className="size-4.5" />
                <span className="truncate underline-offset-2 hover:underline">{agent.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PaneHeader(props: {
  title: string;
  about?: string;
  note?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        {/* A skill's or a server's name in the page's own face: mono is for a name that stands
            as code inside a sentence. */}
        <h2 className="min-w-0 text-title break-words">{props.title}</h2>
        {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
      </div>
      {props.about && <p className="max-w-[72ch] text-read text-ink-2">{props.about}</p>}
      {/* The context column says these as facts once it stands beside the item. */}
      {props.note && <p className={cn('text-small text-ink-3', split.narrow)}>{props.note}</p>}
    </header>
  );
}

export type MenuAction = { label: string; onSelect: () => void; danger?: boolean };

/** What is done to an item less often than editing it; nothing when there is nothing to do. */
export function MoreMenu(props: { name: string; items: (MenuAction | false | undefined)[] }) {
  const items = props.items.filter((item): item is MenuAction => Boolean(item));
  if (items.length === 0) return null;
  return (
    <M.DropdownMenu>
      <M.DropdownMenuTrigger asChild>
        <Button variant="quiet" size="icon-sm" aria-label={`More actions for ${props.name}`}>
          <Ellipsis />
        </Button>
      </M.DropdownMenuTrigger>
      <M.DropdownMenuContent align="end">
        {items.map((item) => (
          <M.DropdownMenuItem
            key={item.label}
            variant={item.danger ? 'danger' : undefined}
            onSelect={item.onSelect}
          >
            {item.label}
          </M.DropdownMenuItem>
        ))}
      </M.DropdownMenuContent>
    </M.DropdownMenu>
  );
}

/** One line of the library's list: the name, and under it what the item is. */
export function ListItem(props: {
  name: string;
  note: string;
  current: boolean;
  onPick: () => void;
}) {
  return (
    <li
      className={cn(
        'relative border-b border-line px-4 py-2 hover:bg-hover',
        // Ink, not the orange of Approvals: nothing in the library waits for anyone.
        props.current &&
          'md:bg-raised md:before:absolute md:before:inset-y-2 md:before:left-0 md:before:w-0.5 md:before:rounded-full md:before:bg-ink',
      )}
    >
      <button
        type="button"
        aria-current={props.current ? 'true' : undefined}
        onClick={props.onPick}
        className="grid w-full min-w-0 gap-0.5 text-left after:absolute after:inset-0"
      >
        <span className="truncate font-medium">{props.name}</span>
        <span className="truncate text-small text-ink-3">{props.note}</span>
      </button>
    </li>
  );
}
