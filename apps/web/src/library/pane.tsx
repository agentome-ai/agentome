import { ArrowLeft, ChevronDown, Ellipsis } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, type ApiError } from '../api';
import { ApiErrorState } from '../session';
import { frame, PageHeader, split } from '../shell/page-header';
import { LoadingState } from '../shell/states';
import { AgentTile } from '../ui/tint';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as M from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { textLink } from '../ui/properties';

// What the Skills and MCP servers pages share: a list on the left, the picked item on the right
// read the same way, a name with what can be done to it, a line of facts, then the thing itself.

/** Past this many items a list offers a filter. */
export const FILTER_FROM = 8;

/**
 * The picked item's side of the page: its header and the item itself under it, in one column
 * as wide as a server's tools want. A skill's text keeps its own measure inside it.
 */
export function Pane(props: {
  label: string;
  /** The page a phone goes back to from the item: Skills or MCP servers. */
  back: string;
  onBack: () => void;
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article
      aria-label={props.label}
      className="grid grid-cols-[minmax(0,1fr)] content-start px-4 pt-4 pb-24 md:px-10 md:pt-8"
    >
      <div className={cn(split.column, 'max-w-260 gap-6')}>
        {/* A phone shows the list or the item, never both. */}
        <button
          type="button"
          onClick={props.onBack}
          className="-ml-1 inline-flex items-center gap-1 justify-self-start text-read text-ink-2 md:hidden"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {props.back}
        </button>
        {props.header}
        {props.children}
      </div>
    </article>
  );
}

/**
 * The item's name, what it is for, and its facts in one line under them. The facts once stood in
 * a column of their own beside the item from 1800 px, which left the page in three thin strips;
 * the owner asked for one.
 */
export function PaneHeader(props: {
  title: string;
  about?: string;
  actions?: ReactNode;
  /** Under the line about it: an address, a sign-in. */
  children?: ReactNode;
  facts?: readonly Fact[];
}) {
  return (
    <header className="grid gap-2.5 border-b border-line pb-5">
      <div className="flex items-start justify-between gap-3">
        {/* A skill's or a server's name in the page's own face: mono is for a name that stands
            as code inside a sentence. */}
        <h2 className="min-w-0 text-title break-words">{props.title}</h2>
        {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
      </div>
      {props.about && <p className="max-w-[72ch] text-read text-ink-2">{props.about}</p>}
      {props.children}
      {props.facts && <Facts facts={props.facts} />}
    </header>
  );
}

export type Fact = readonly [label: string, value: ReactNode];

/** Facts as a line that wraps: each label quiet, its value beside it. */
function Facts({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="mt-0.5 flex flex-wrap gap-x-6 gap-y-1.5 text-small">
      {facts.map(([label, value]) => (
        <div key={label} className="flex min-w-0 items-baseline gap-1.5">
          <dt className="shrink-0 text-ink-3">{label}</dt>
          <dd className="min-w-0 text-ink-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Which of the person's agents have the item, as a fact's value: the one thing about a skill
 * or a server that no other page says.
 */
export function UsedBy({ url }: { url: string }) {
  const [agents, setAgents] = useState<{ id: string; name: string }[] | 'failed'>();
  useEffect(() => {
    let current = true;
    api<{ agents: { id: string; name: string }[] }>(url).then(
      (answer) => current && setAgents(answer.agents),
      () => current && setAgents('failed'),
    );
    return () => {
      current = false;
    };
  }, [url]);
  if (agents === undefined) return <span className="text-ink-3">…</span>;
  if (agents === 'failed') return <span>Couldn't load</span>;
  if (agents.length === 0) return <span>None of your agents</span>;
  return (
    <ul aria-label="Agents that have it" className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {agents.map((agent) => (
        <li key={agent.id} className="min-w-0">
          <Link to={`/agents/${agent.id}`} className="inline-flex max-w-full items-center gap-1.5">
            <AgentTile id={agent.id} name={agent.name} className="size-4" />
            <span className={cn('truncate', textLink)}>{agent.name}</span>
          </Link>
        </li>
      ))}
    </ul>
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

/** One line of a list: the name, and under it what the item is. */
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
        // Ink, not the orange of Approvals: nothing here waits for anyone.
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

/** A filter over a list, with Escape to clear it. */
export function ListFilter(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Input
      type="search"
      aria-label={props.label}
      placeholder={props.label}
      value={props.value}
      className={props.className}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => event.key === 'Escape' && props.onChange('')}
    />
  );
}

/** Whether a filter's words are all in the text, in any case. */
export function matches(filter: string, text: string): boolean {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * A row that opens to show the rest of its text: one line shut, the whole text open. A server's
 * tools are read this way, so that eighteen of them fit a screen.
 */
export function Expandable(props: { head: ReactNode; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-line not-first:border-t">
      <button
        type="button"
        aria-expanded={props.text ? open : undefined}
        disabled={!props.text}
        onClick={() => setOpen(!open)}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-3 py-2 text-left enabled:hover:bg-hover"
      >
        <span className="grid min-w-0 gap-0.5">
          {props.head}
          {props.text && (
            <span className={cn('text-small text-ink-2', open ? 'break-words' : 'truncate')}>
              {props.text}
            </span>
          )}
        </span>
        {props.text && (
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'mt-0.5 size-4 text-ink-3 transition-transform motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        )}
      </button>
    </li>
  );
}

/**
 * A page of a list and the item picked from it, as Approvals is: the list on the left under the
 * page's title, the item beside it. On a phone the list is the page and an item opens over it.
 */
export function ListPage(props: {
  title: string;
  /** Whether the address names an item: then a phone shows the item, not the list. */
  named: boolean;
  head: ReactNode;
  list: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader title={props.title} />
      <div className={split.page}>
        <nav
          aria-label={props.title}
          className={cn(split.list, 'pb-6', props.named && 'max-md:hidden')}
        >
          <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
            {props.head}
          </div>
          {props.list}
        </nav>
        <div className={cn(split.item, !props.named && 'max-md:hidden')}>{props.children}</div>
      </div>
    </>
  );
}

/** The page while its list loads, or when it could not. */
export function ListPageState(props: {
  title: string;
  what: string;
  error?: ApiError;
  onRetry: () => void;
}) {
  return (
    <>
      <PageHeader title={props.title} />
      <div className={cn(frame.wide, 'pt-6')}>
        {props.error ? (
          <ApiErrorState
            title={`Couldn't load the ${props.what}`}
            error={props.error}
            onRetry={props.onRetry}
          />
        ) : (
          <LoadingState label={`Loading the ${props.what}`} />
        )}
      </div>
    </>
  );
}
