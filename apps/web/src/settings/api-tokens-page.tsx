import { CalendarClock, Ellipsis, KeyRound, Plus, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, asApiError, formatDate, timeAgo } from '../api';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, ErrorState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { fieldChip } from '../ui/chip';
import { cn } from '../ui/cn';
import { Copyable } from '../ui/copyable';
import * as D from '../ui/dialog';
import * as M from '../ui/dropdown-menu';
import { Select, SelectChip, SelectContent, SelectItem } from '../ui/select';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import { leadTile } from '../ui/tint';

// A person's tokens for the management MCP and the API: named, shown once when made,
// revoked here. The command for Claude Code stands next to a new token, so the one time the token
// is in view is the time it is needed. A token is made for a time, up to a year, and may be made
// to read only. A page of its own, as Linear's; New token is a composer.

type Scope = 'read' | 'write';
type Token = {
  id: string;
  name: string;
  scope: Scope;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};
type Made = Token & { token: string };

const DAY = 24 * 60 * 60 * 1000;
const EXPIRY = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'custom', label: 'Custom' },
  { value: 'never', label: 'No expiry' },
];
const scopeLabel: Record<Scope, string> = { write: 'Read and write', read: 'Read only' };

/** The days a custom expiry asks for, or undefined while it is not a whole number up to 365. */
function customDays(text: string): number | undefined {
  const days = Number(text);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : undefined;
}

export function ApiTokensPage() {
  const [tokens, setTokens] = useState<Token[]>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setError(undefined);
    api<{ tokens: Token[] }>('/api/me/tokens').then(
      (data) => setTokens(data.tokens),
      (caught) => setError(asApiError(caught).message),
    );
  }, []);
  useEffect(load, [load]);

  async function revoke(id: string) {
    try {
      await api(`/api/me/tokens/${id}`, { method: 'DELETE' });
      setTokens((was) => was?.filter((token) => token.id !== id));
    } catch (caught) {
      setError(asApiError(caught).message);
    }
  }

  const newToken = (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <Plus aria-hidden="true" className="size-3.5" />
      New token
    </Button>
  );
  return (
    <>
      <PageHeader
        title="API tokens"
        titleIn="bar"
        phoneBack={{ label: 'More', to: '/more' }}
        actions={tokens?.length ? newToken : undefined}
      />
      <div className={cn('pt-6 pb-24 max-md:pt-2', frame.wide)}>
        <p className="mb-4 max-w-[72ch] text-ink-2">
          A token acts as you: Claude Code or a script can do with it what you can do here, or only
          read. Revoke one the moment it is not needed.
        </p>
        {error && !tokens ? (
          <ErrorState title="Couldn't load your tokens" onRetry={load}>
            {error}
          </ErrorState>
        ) : !tokens ? (
          <LoadingState label="Loading your tokens" />
        ) : tokens.length === 0 ? (
          <EmptyState title="No tokens yet" action={newToken}>
            Make one to connect Claude Code or a script to Agentome.
          </EmptyState>
        ) : (
          <>
            {error && <p className="mb-3 text-small text-failed">{error}</p>}
            <Tokens tokens={tokens} onRevoke={(id) => void revoke(id)} />
          </>
        )}
      </div>
      <NewTokenDialog
        open={creating}
        onOpenChange={setCreating}
        onMade={(token) => setTokens((was) => [token, ...(was ?? [])])}
      />
    </>
  );
}

function Tokens(props: { tokens: Token[]; onRevoke: (id: string) => void }) {
  return (
    <Table phoneList aria-label="Your tokens" className="-mx-3 w-[calc(100%+24px)] table-fixed">
      <colgroup>
        <col />
        <col className="w-36" />
        <col className="w-44" />
        <col className="w-40 max-lg:hidden" />
        <col className="w-12" />
      </colgroup>
      <thead>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Access</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead className="max-lg:hidden">Last used</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </thead>
      <tbody>
        {props.tokens.map((token) => (
          <TableRow key={token.id}>
            <TableCell data-lead className="md:hidden">
              <span className={cn(leadTile, 'grid place-items-center bg-selected text-ink-2')}>
                <KeyRound aria-hidden="true" className="size-4.5" />
              </span>
            </TableCell>
            <TableCell primary className="font-medium">
              <span className="flex min-w-0 items-center gap-2">
                <KeyRound aria-hidden="true" className="size-4 shrink-0 text-ink-3 max-md:hidden" />
                <span className="truncate">{token.name}</span>
              </span>
            </TableCell>
            <TableCell className="text-ink-2">{scopeLabel[token.scope]}</TableCell>
            <TableCell>
              <Expiry at={token.expiresAt} />
            </TableCell>
            {/* A phone has no room for when it was used: the menu and the date say enough. */}
            <TableCell className="text-ink-3 max-lg:hidden">
              {token.lastUsedAt
                ? `Used ${timeAgo(token.lastUsedAt)}`
                : `Made ${formatDate(token.createdAt)}`}
            </TableCell>
            <TableCell data-menu className="py-0 pr-2 text-right">
              <M.DropdownMenu>
                <M.DropdownMenuTrigger asChild>
                  <Button variant="quiet" size="icon-sm" aria-label={`Actions for ${token.name}`}>
                    <Ellipsis />
                  </Button>
                </M.DropdownMenuTrigger>
                <M.DropdownMenuContent align="end">
                  <M.DropdownMenuItem variant="danger" onSelect={() => props.onRevoke(token.id)}>
                    Revoke
                  </M.DropdownMenuItem>
                </M.DropdownMenuContent>
              </M.DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
  );
}

function Expiry(props: { at: string | null }) {
  if (!props.at) return <span className="text-ink-3">No expiry</span>;
  const past = new Date(props.at).getTime() <= Date.now();
  return (
    <span className={past ? 'text-failed' : 'text-ink-2'}>
      {past ? 'Expired' : 'Expires'} {formatDate(props.at)}
    </span>
  );
}

/** New token as a composer, as New task: its name large, its expiry and access as chips. */
function NewTokenDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMade: (token: Made) => void;
}) {
  return (
    <D.Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <D.DialogContent
        size="wide"
        className={D.composer}
        onOpenAutoFocus={(event) => {
          const name = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
            '[data-field="name"]',
          );
          if (!name) return;
          event.preventDefault();
          name.focus();
        }}
      >
        {/* Mounted only while open: every opening starts a new token. */}
        <NewTokenForm onMade={props.onMade} />
      </D.DialogContent>
    </D.Dialog>
  );
}

function NewTokenForm(props: { onMade: (token: Made) => void }) {
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('30');
  const [custom, setCustom] = useState('180');
  const [scope, setScope] = useState<Scope>('write');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<Made>();
  const form = useRef<HTMLFormElement>(null);

  const days =
    expiry === 'never' ? null : expiry === 'custom' ? customDays(custom) : Number(expiry);
  const ready = name.trim() !== '' && days !== undefined;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (pending || !ready) return;
    setPending(true);
    setError(undefined);
    try {
      const token = await api<Made>('/api/me/tokens', {
        method: 'POST',
        body: { name, scope, expiresInDays: days },
      });
      setMade(token);
      props.onMade(token);
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  const header = (title: string) => (
    // A phone's sheet has Cancel on the left and the title in the middle; a wide screen, the
    // title on the left and a close button on the right.
    <div className="flex items-center gap-2 pt-3 pr-3 pl-5 max-md:grid max-md:grid-cols-[1fr_auto_1fr] max-md:border-b max-md:border-line max-md:px-2 max-md:py-2">
      <D.DialogClose asChild>
        <Button variant="quiet" type="button" className="justify-self-start md:hidden">
          {made ? 'Close' : 'Cancel'}
        </Button>
      </D.DialogClose>
      <D.DialogTitle className="text-ui text-ink-2 max-md:text-section max-md:text-ink">
        {title}
      </D.DialogTitle>
      <D.DialogDescription className="sr-only">
        A token that acts as you, for Claude Code or a script.
      </D.DialogDescription>
      <D.DialogClose asChild>
        <Button
          variant="quiet"
          size="icon-sm"
          type="button"
          aria-label="Close"
          className="ml-auto max-md:hidden"
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </D.DialogClose>
    </div>
  );

  if (made) {
    const command = `claude mcp add --transport http agentome ${window.location.origin}/mcp/manage --header "Authorization: Bearer ${made.token}"`;
    return (
      <div className="flex flex-col">
        {header('New token')}
        <div className="grid gap-3 px-5 pt-3 pb-5 max-md:px-4 max-md:pt-4">
          <p className="text-title">{made.name} is ready</p>
          <p className="text-ink-2">Copy it now: it is shown once.</p>
          <Copyable label="Copy token" value={made.token} />
          <p className="mt-2 text-small text-ink-2">
            To connect Claude Code, run this once. It keeps the token in your shell history and in
            Claude Code's own config: revoke the token here if either leaks.
          </p>
          <Copyable label="Copy command" value={command} />
        </div>
        <div className="flex justify-end border-t border-line py-3 pr-4 pl-5 max-md:px-4">
          <D.DialogClose asChild>
            <Button variant="primary">Done</Button>
          </D.DialogClose>
        </div>
      </div>
    );
  }

  return (
    <form
      ref={form}
      onSubmit={(event) => void create(event)}
      noValidate
      className="flex flex-col"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        form.current?.requestSubmit();
      }}
    >
      {header('New token')}
      <div className="grid gap-1.5 px-5 pt-3 max-md:px-4 max-md:pt-4">
        <input
          data-field="name"
          aria-label="Token name"
          placeholder="Token name"
          maxLength={100}
          value={name}
          className="bg-transparent text-title text-ink outline-none placeholder:text-ink-3"
          onChange={(event) => setName(event.target.value)}
        />
        <p className="text-read text-ink-3">
          Name it after what will hold it: Claude Code on my MacBook, the weekly report script.
        </p>
      </div>
      <div className="grid gap-3 px-5 pt-4 pb-4 max-md:px-4">
        <div role="group" aria-label="About this token" className="flex flex-wrap gap-1.5">
          <Select value={expiry} onValueChange={setExpiry}>
            <SelectChip aria-label={`Expires: ${EXPIRY.find((o) => o.value === expiry)?.label}`}>
              <CalendarClock aria-hidden="true" className="text-ink-3" />
              <span className="truncate">
                {EXPIRY.find((option) => option.value === expiry)?.label}
              </span>
            </SelectChip>
            <SelectContent>
              {EXPIRY.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {expiry === 'custom' && (
            <label className={cn(fieldChip, 'cursor-text', days === undefined && 'border-failed')}>
              <input
                aria-label="Days"
                aria-invalid={days === undefined || undefined}
                inputMode="numeric"
                value={custom}
                onChange={(event) => setCustom(event.target.value.trim())}
                className="w-9 bg-transparent text-right outline-none"
              />
              <span className="text-ink-2">days</span>
            </label>
          )}
          <Select value={scope} onValueChange={(value) => setScope(value as Scope)}>
            <SelectChip aria-label={`Access: ${scopeLabel[scope]}`}>
              <ShieldCheck aria-hidden="true" className="text-ink-3" />
              <span className="truncate">{scopeLabel[scope]}</span>
            </SelectChip>
            <SelectContent>
              <SelectItem value="write" description="Everything you can do here">
                Read and write
              </SelectItem>
              <SelectItem value="read" description="Sees everything, changes nothing">
                Read only
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {expiry === 'custom' && days === undefined && (
          <p className="text-small text-failed">A custom expiry is from 1 to 365 days.</p>
        )}
        {error && <p className="text-small text-failed">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line py-3 pr-4 pl-5 max-md:px-4">
        <p className="flex min-w-0 items-center gap-2 text-small text-ink-3">
          <CalendarClock aria-hidden="true" className="size-3.5 shrink-0" />
          {until(days)}
        </p>
        <Button
          variant="primary"
          type="submit"
          disabled={pending || !ready}
          title="⌘↵"
          className="ml-auto"
        >
          {pending ? 'Creating…' : 'Create token'}
        </Button>
      </div>
    </form>
  );
}

/** Under the chips: the date a new token would stop, from today. */
function until(days: number | null | undefined): string {
  if (days === undefined) return 'Pick how long it works';
  if (days === null) return 'Works until you revoke it';
  return `Works until ${formatDate(new Date(Date.now() + days * DAY).toISOString())}`;
}
