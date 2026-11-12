import { Folder, UsersRound } from 'lucide-react';
import { cn } from './cn';

// A project's or a team's own colour, the same wherever it shows: picked from its id, so it
// needs no field and no setting. Eight tints, each 3:1 on every surface in both themes.
const tints = [
  'text-tint-1',
  'text-tint-2',
  'text-tint-3',
  'text-tint-4',
  'text-tint-5',
  'text-tint-6',
  'text-tint-7',
  'text-tint-8',
];

export function tintOf(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tints[hash % tints.length] ?? 'text-ink-2';
}

/** A project's folder or a team's people, in its colour, before its name. */
export function Tint(props: { id: string; kind: 'project' | 'team'; className?: string }) {
  const Icon = props.kind === 'project' ? Folder : UsersRound;
  return (
    <Icon
      aria-hidden="true"
      className={cn('inline size-3.5 shrink-0 align-[-2px]', tintOf(props.id), props.className)}
    />
  );
}

/** A name's first letters: "Delivery lead" is "DL". */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((word) => word[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** An agent's initials on a tile of its own colour, before its name. */
export function AgentTile(props: { id: string; name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-md bg-current/15 text-[10px] font-semibold',
        tintOf(props.id),
        props.className,
      )}
    >
      {initials(props.name)}
    </span>
  );
}

/** A person's initials on a round of their own colour: round, where an agent's tile is square. */
export function PersonAvatar(props: { id: string; name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-full bg-current/15 text-[10px] font-semibold',
        tintOf(props.id),
        props.className,
      )}
    >
      {initials(props.name)}
    </span>
  );
}

/** A phone list row's lead: the agent's tile, two lines tall, before the row's words. */
export const leadTile = 'size-9 rounded-[10px] text-xs';

/** A list's agent cell: tile and name on a wide screen; "· name" after the status on a phone. */
export function AgentCell({ agent }: { agent: { id: string; name: string } }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 md:gap-2">
      <span aria-hidden="true" className="text-ink-3 md:hidden">
        ·
      </span>
      <AgentTile id={agent.id} name={agent.name} className="max-md:hidden" />
      <span className="truncate">{agent.name}</span>
    </span>
  );
}
