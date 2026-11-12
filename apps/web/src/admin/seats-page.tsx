import { Cpu, Ellipsis, Laptop, type LucideIcon, Server } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { timeAgo } from '../api';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, ErrorState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { useMe } from '../session';
import { PlaceSection } from './place-section';
import { Copyable } from '../ui/copyable';
import * as D from '../ui/dialog';
import * as M from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Presence, Status } from '../ui/status';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { leadTile } from '../ui/tint';
import {
  api,
  ApiError,
  isOnline,
  signedOutNote,
  toApiError,
  useSeats,
  waitsForSandbox,
  type Seat,
} from './seats-data';

type Pairing = {
  code: string;
  expiresAt: string;
  command: string;
  /** The same in PowerShell; null where `command` is a checkout's. */
  windowsCommand: string | null;
  checkout: boolean;
};

const kinds: Record<Seat['kind'], [string, LucideIcon]> = {
  'subscription-laptop': ['Person’s computer', Laptop],
  'api-server': ['API server', Server],
  'local-model': ['Local model', Cpu],
  'subscription-server': ['Person’s place on the server', Server],
};

// [label, <col> width, cell classes]. The kind is the name's icon. On narrow screens Last seen
// gives way; the <col> and its cells hide together, so the cells after keep their columns. A
// phone reads the table as a list: status and activity under the name, or when it was last seen.
const columns: [string, string, string][] = [
  ['Name', '', 'font-medium'],
  ['Status', 'w-28', ''],
  ['Last seen', 'w-32 max-lg:hidden', 'text-ink-2 max-lg:hidden'],
  ['Activity', 'w-60 2xl:w-76', ''],
  ['', 'w-14', ''],
];

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function lastSeen(seat: Seat): string {
  if (!seat.lastSeenAt) return 'Never';
  const ago = timeAgo(seat.lastSeenAt);
  return ago.charAt(0).toUpperCase() + ago.slice(1);
}

/**
 * Admin → Computers: the computers that run the person's agents, and how to connect another.
 * The API calls them seats; the page says what they are.
 */
export function SeatsPage() {
  const { seats, error, reload } = useSeats();
  const [connecting, setConnecting] = useState(false);
  const [renaming, setRenaming] = useState<Seat | null>(null);
  const [revoking, setRevoking] = useState<Seat | null>(null);
  const [removing, setRemoving] = useState<Seat | null>(null);
  const [updating, setUpdating] = useState<Seat | null>(null);
  const [sandboxing, setSandboxing] = useState<Seat | null>(null);
  // The dialogs open from a row menu or the header, not from a DialogTrigger, so they hand
  // focus back themselves: to the row's menu button, or to Connect a computer.
  const row = useRef('');
  const refocus = (event: Event) => {
    event.preventDefault();
    const rowButton = document.querySelector<HTMLElement>(`[data-actions="${row.current}"]`);
    (rowButton ?? document.querySelector<HTMLElement>('[data-connect]'))?.focus();
  };
  const connect = (
    <Button
      variant="primary"
      data-connect
      onClick={() => {
        row.current = '';
        setConnecting(true);
      }}
    >
      Connect a computer
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Computers"
        crumbs={[{ label: 'Admin', to: '/admin' }]}
        actions={seats?.length ? connect : undefined}
      />
      <div className={cn('pt-4 pb-24', frame.wide)}>
        <PlaceSection />
        <p className="mb-4 max-w-[72ch] text-read text-ink-2">
          The computers that run your agents. A computer takes runs only while you are signed in to
          it and using it.
        </p>
        {seats === null && error ? (
          <ErrorState title="Couldn't load the computers" onRetry={() => void reload()}>
            {error.message}
          </ErrorState>
        ) : seats === null ? (
          <LoadingState label="Loading the computers" />
        ) : seats.length === 0 ? (
          <EmptyState title="No computers connected" action={connect}>
            Connect the computer you work on, and your agents run there with your Claude
            subscription.
          </EmptyState>
        ) : (
          <SeatsTable
            seats={seats}
            onAction={(seat, action) => {
              row.current = seat.id;
              const open = {
                settings: setRenaming,
                revoke: setRevoking,
                remove: setRemoving,
                update: setUpdating,
                sandbox: setSandboxing,
              };
              open[action](seat);
            }}
          />
        )}
      </div>
      <ConnectDialog
        open={connecting}
        onCloseAutoFocus={refocus}
        onOpenChange={(open) => {
          setConnecting(open);
          if (!open) void reload();
        }}
      />
      <SettingsDialog
        seat={renaming}
        onClose={() => setRenaming(null)}
        onDone={reload}
        onCloseAutoFocus={refocus}
      />
      <UpdateDialog
        seat={updating}
        onClose={() => {
          setUpdating(null);
          void reload();
        }}
        onCloseAutoFocus={refocus}
      />
      <SandboxDialog
        seat={sandboxing}
        onClose={() => setSandboxing(null)}
        onDone={reload}
        onCloseAutoFocus={refocus}
      />
      <RemoveDialog
        seat={removing}
        onClose={() => setRemoving(null)}
        onDone={reload}
        onCloseAutoFocus={refocus}
      />
      <RevokeDialog
        seat={revoking}
        onClose={() => setRevoking(null)}
        onDone={reload}
        onCloseAutoFocus={refocus}
      />
    </>
  );
}

function SeatsTable(props: {
  seats: Seat[];
  onAction: (seat: Seat, action: 'settings' | 'revoke' | 'remove' | 'update' | 'sandbox') => void;
}) {
  const admin = useMe().role === 'admin';
  return (
    <Table phoneList className="-mx-3 w-[calc(100%+24px)] table-fixed">
      <colgroup>
        {columns.map(([label, width]) => (
          <col key={label || 'actions'} className={width} />
        ))}
      </colgroup>
      <thead>
        <TableRow>
          {columns.map(([label, , className]) => (
            <TableHead key={label || 'actions'} className={className}>
              {label || <span className="sr-only">Actions</span>}
            </TableHead>
          ))}
        </TableRow>
      </thead>
      <tbody>
        {props.seats.map((seat) => {
          const revoked = seat.status === 'revoked';
          const online = isOnline(seat);
          const signedOut = signedOutNote(seat);
          // A revoked seat stays in the list as a record, faint in every cell.
          const cell = (column: number) => cn(columns[column]?.[2], revoked && 'text-ink-3');
          const [kind, Kind] = kinds[seat.kind];
          return (
            <TableRow key={seat.id}>
              <TableCell data-lead className="md:hidden">
                <span
                  className={cn(
                    leadTile,
                    'grid place-items-center bg-selected text-ink-2',
                    revoked && 'text-ink-3',
                  )}
                >
                  <Kind className="size-4.5" />
                </span>
              </TableCell>
              <TableCell primary className={cell(0)}>
                <span className="flex min-w-0 items-center gap-2">
                  <Kind className="size-4 shrink-0 text-ink-3 max-md:hidden" />
                  <span className="truncate">{seat.name}</span>
                  <span className="sr-only">, {kind}</span>
                </span>
              </TableCell>
              <TableCell>
                {revoked ? (
                  <span className="text-ink-3">Revoked</span>
                ) : (
                  <Presence online={online} className={cn(!online && 'text-ink-2')}>
                    {online ? 'Online' : 'Offline'}
                  </Presence>
                )}
              </TableCell>
              {/* A phone says when an offline computer was last seen; an online one, what it does. */}
              <TableCell className={cn(cell(2), online ? 'max-md:hidden' : 'max-md:block')}>
                {lastSeen(seat)}
              </TableCell>
              <TableCell className={columns[3]?.[2]}>
                {seat.activeRun ? (
                  <Status status="running">Running {seat.activeRun.agentName}</Status>
                ) : waitsForSandbox(seat) ? (
                  // Windows: its runs wait in the queue until an admin allows it (the row's menu).
                  <span className="text-ink-2">Waiting for an admin</span>
                ) : signedOut ? (
                  // Its runs wait in the queue until the person signs in on that computer.
                  <span className="text-ink-2">{signedOut}</span>
                ) : seat.updateCommand ? (
                  // It still takes runs; the row's menu has the command that updates it.
                  <span className="text-ink-2">Worker out of date</span>
                ) : (
                  online && <span className="text-ink-3">Ready for runs</span>
                )}
              </TableCell>
              <TableCell data-menu className="py-0 pr-2 text-right">
                <M.DropdownMenu>
                  <M.DropdownMenuTrigger asChild>
                    <Button
                      variant="quiet"
                      size="icon-sm"
                      aria-label={`Actions for ${seat.name}`}
                      data-actions={seat.id}
                    >
                      <Ellipsis />
                    </Button>
                  </M.DropdownMenuTrigger>
                  <M.DropdownMenuContent align="end">
                    {revoked ? (
                      // A record once revoked: the one thing left to do with it is to let it go.
                      <M.DropdownMenuItem onSelect={() => props.onAction(seat, 'remove')}>
                        Remove from the list
                      </M.DropdownMenuItem>
                    ) : (
                      <>
                        {seat.updateCommand && (
                          <M.DropdownMenuItem onSelect={() => props.onAction(seat, 'update')}>
                            Update the worker
                          </M.DropdownMenuItem>
                        )}
                        {admin && seat.sandbox.none && (
                          <M.DropdownMenuItem onSelect={() => props.onAction(seat, 'sandbox')}>
                            {seat.sandbox.allowedAt
                              ? 'Stop runs without a sandbox'
                              : 'Allow runs without a sandbox'}
                          </M.DropdownMenuItem>
                        )}
                        <M.DropdownMenuItem onSelect={() => props.onAction(seat, 'settings')}>
                          Settings
                        </M.DropdownMenuItem>
                        <M.DropdownMenuSeparator />
                        <M.DropdownMenuItem
                          variant="danger"
                          onSelect={() => props.onAction(seat, 'revoke')}
                        >
                          Revoke seat
                        </M.DropdownMenuItem>
                      </>
                    )}
                  </M.DropdownMenuContent>
                </M.DropdownMenu>
              </TableCell>
            </TableRow>
          );
        })}
      </tbody>
    </Table>
  );
}

function ConnectDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const admin = useMe().role === 'admin';
  const [pairing, setPairing] = useState<Pairing | ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Every opening makes a new code: an earlier one may have expired or been used.
  useEffect(() => {
    if (!props.open) return;
    let current = true;
    setPairing(null);
    api<Pairing>('/api/seats/pairing-codes', { method: 'POST' }).then(
      (made) => current && setPairing(made),
      (error: unknown) => current && setPairing(toApiError(error)),
    );
    return () => {
      current = false;
    };
  }, [props.open, attempt]);

  return (
    <D.Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <D.DialogContent size="wide" onCloseAutoFocus={props.onCloseAutoFocus}>
        <D.DialogTitle>Connect a computer</D.DialogTitle>
        <D.DialogDescription>
          Run this command in a terminal on the computer you want to connect. It needs Node.js 20 or
          later and Claude Code or Codex, signed in with your own subscription.
        </D.DialogDescription>
        {pairing === null ? (
          <p role="status" className="py-6 text-ink-2">
            Creating a code…
          </p>
        ) : pairing instanceof ApiError ? (
          <ErrorState title="Couldn't create a code" onRetry={() => setAttempt((n) => n + 1)}>
            {pairing.message}
          </ErrorState>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
            <div>
              <p className="font-mono text-name font-normal tracking-[0.06em] [font-variant-numeric:slashed-zero]">
                {pairing.code}
              </p>
              <p className="mt-1 text-small text-ink-3">
                Works once, until {time(pairing.expiresAt)}.
              </p>
            </div>
            {!pairing.windowsCommand ? (
              <div>
                <Copyable label="Copy command" value={pairing.command} />
                {pairing.checkout && (
                  <p className="mt-2 text-small text-ink-3">
                    Run it in a checkout of the repository.
                  </p>
                )}
              </div>
            ) : (
              <Tabs defaultValue={windowsBrowser() ? 'windows' : 'unix'} className="grid gap-3">
                <TabsList aria-label="The computer's system">
                  <TabsTrigger value="unix">macOS or Linux</TabsTrigger>
                  <TabsTrigger value="windows">Windows</TabsTrigger>
                </TabsList>
                <TabsContent value="unix">
                  <Copyable label="Copy command" value={pairing.command} />
                </TabsContent>
                <TabsContent value="windows" className="grid gap-2">
                  <Copyable label="Copy command" value={pairing.windowsCommand} />
                  <p className="text-small text-ink-3">
                    Run it in PowerShell. Windows has no sandbox for the agent’s commands: the
                    computer takes runs once an admin allows it to run them without one.
                  </p>
                </TabsContent>
              </Tabs>
            )}
            {/* An admin's code also connects the server seat, for agents set to the server. */}
            {admin && (
              <div className="grid gap-2 border-t border-line pt-4">
                <p className="text-small text-ink-2">
                  Or connect the server seat with it, on the machine that runs Agentome:
                </p>
                <Copyable
                  label="Copy command"
                  value={`docker compose run --rm seat connect ${pairing.code} --server http://app:3000`}
                />
              </div>
            )}
          </div>
        )}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button>Done</Button>
          </D.DialogClose>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}

/** Whether this browser is on Windows: the Connect dialog opens on the Windows command there. */
const windowsBrowser = () => /Windows/.test(navigator.userAgent);

type RowDialogProps = {
  seat: Seat | null;
  onClose: () => void;
  onDone: () => Promise<void>;
  onCloseAutoFocus: (event: Event) => void;
};

/** A row dialog's request: on success the list reloads and the dialog closes; on failure it stays with the error. */
function useRowAction(props: RowDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(null), [props.seat]);
  async function run(request: () => Promise<unknown>) {
    setBusy(true);
    try {
      await request();
      await props.onDone();
      props.onClose();
    } catch (failure) {
      setError(toApiError(failure).message);
    } finally {
      setBusy(false);
    }
  }
  return { error, setError, busy, run };
}

/** The seat's name, and how long the computer may stand without a person before it takes no runs. */
function SettingsDialog(props: RowDialogProps) {
  const [name, setName] = useState('');
  const [idle, setIdle] = useState('15');
  const action = useRowAction(props);
  useEffect(() => {
    setName(props.seat?.name ?? '');
    setIdle(String(props.seat?.idleMinutes ?? 15));
  }, [props.seat]);

  function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return action.setError('Enter a name for this computer.');
    const idleMinutes = Number(idle);
    if (!Number.isInteger(idleMinutes) || idleMinutes < 5 || idleMinutes > 120) {
      return action.setError('Idle time is a whole number of minutes from 5 to 120.');
    }
    const body = JSON.stringify({ name, idleMinutes });
    void action.run(() => api(`/api/seats/${props.seat?.id}`, { method: 'PATCH', body }));
  }

  return (
    <D.Dialog open={props.seat !== null} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
        <form onSubmit={save} className="grid gap-4">
          <D.DialogTitle>Settings of {props.seat?.name}</D.DialogTitle>
          <D.DialogDescription>
            The name shows in the sidebar and next to its runs. The idle time is how long the
            computer may stand without anyone at the keyboard before it takes no runs; the worker
            picks a change up within a minute.
          </D.DialogDescription>
          <div className="grid gap-1.5">
            <label htmlFor="seat-name" className="font-medium">
              Name
            </label>
            <Input
              id="seat-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={action.error ? true : undefined}
              aria-describedby={action.error ? 'seat-error' : undefined}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="seat-idle" className="font-medium">
              Idle time, minutes
            </label>
            <Input
              id="seat-idle"
              inputMode="numeric"
              value={idle}
              className="w-28"
              onChange={(event) => setIdle(event.target.value)}
              aria-describedby={action.error ? 'seat-error' : 'seat-idle-hint'}
            />
            <p id="seat-idle-hint" className="text-small text-ink-3">
              From 5 to 120. Runs happen only while somebody is at the computer.
            </p>
          </div>
          {action.error && (
            <p id="seat-error" className="text-small text-failed">
              {action.error}
            </p>
          )}
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button variant="quiet" type="button">
                Cancel
              </Button>
            </D.DialogClose>
            <Button variant="primary" type="submit" disabled={action.busy}>
              Save
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}

/**
 * The command that brings a computer's worker up to the server's. A person runs it there: the
 * server never puts a worker on a computer by itself.
 */
function UpdateDialog(props: Omit<RowDialogProps, 'onDone'>) {
  const seat = props.seat;
  const laptop = seat?.kind === 'subscription-laptop';
  return (
    <D.Dialog open={seat !== null} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent size="wide" onCloseAutoFocus={props.onCloseAutoFocus}>
        <D.DialogTitle>Update the worker on {seat?.name}</D.DialogTitle>
        <D.DialogDescription>
          {laptop
            ? 'This computer runs an older worker than this server hands out. Run this command in a terminal on it, when it has no run in progress. It stays connected, with its name and settings.'
            : 'The seat runs an older image than the server. Start it again from the server’s version, on the machine that runs it. It stays connected.'}
        </D.DialogDescription>
        <Copyable label="Copy command" value={seat?.updateCommand ?? ''} />
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button>Done</Button>
          </D.DialogClose>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}

/**
 * An admin's decision for a Windows computer: Windows has no sandbox, so the agent's commands
 * there read what its person can read and reach what the computer reaches.
 */
function SandboxDialog(props: RowDialogProps) {
  const action = useRowAction(props);
  const seat = props.seat;
  const allowed = seat?.sandbox.allowedAt != null;
  const decide = () =>
    action.run(() =>
      api(`/api/seats/${seat?.id}/sandbox`, {
        method: 'PUT',
        body: JSON.stringify({ allowed: !allowed }),
      }),
    );
  return (
    <D.Dialog open={seat !== null} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
        <D.DialogTitle>
          {allowed
            ? `Stop runs without a sandbox on ${seat?.name}?`
            : `Allow runs without a sandbox on ${seat?.name}?`}
        </D.DialogTitle>
        <D.DialogDescription>
          {allowed
            ? `The computer stops taking runs${seat?.activeRun ? `, and its run of ${seat.activeRun.agentName} is cancelled` : ''}. It stays connected, and you can allow it again.`
            : `${seat?.owner.name}’s computer runs Windows, which has no sandbox for the agent’s commands. They will read what ${seat?.owner.name} can read on it, including files outside the project, and reach any address it reaches. Allow it on a computer kept for work, such as a company virtual machine.`}
        </D.DialogDescription>
        {action.error && (
          <p role="alert" className="text-failed">
            {action.error}
          </p>
        )}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="quiet">Cancel</Button>
          </D.DialogClose>
          <Button
            variant={allowed ? 'danger' : 'primary'}
            disabled={action.busy}
            onClick={() => void decide()}
          >
            {allowed ? 'Stop runs' : 'Allow runs'}
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}

/** Lets a revoked seat go from the list; its runs keep naming it. */
function RemoveDialog(props: RowDialogProps) {
  const action = useRowAction(props);
  const seat = props.seat;
  return (
    <D.Dialog open={seat !== null} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
        <D.DialogTitle>Remove {seat?.name} from the list?</D.DialogTitle>
        <D.DialogDescription>
          It was revoked already and cannot come back. Its past runs keep its name.
        </D.DialogDescription>
        {action.error && (
          <p role="alert" className="text-failed">
            {action.error}
          </p>
        )}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="quiet">Cancel</Button>
          </D.DialogClose>
          <Button
            variant="primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(() => api(`/api/seats/${seat?.id}/remove`, { method: 'POST' }))
            }
          >
            Remove
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}

function RevokeDialog(props: RowDialogProps) {
  const action = useRowAction(props);
  const seat = props.seat;
  return (
    <D.Dialog open={seat !== null} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
        <D.DialogTitle>Revoke {seat?.name}?</D.DialogTitle>
        <D.DialogDescription>
          The computer stops taking runs at once
          {seat?.activeRun ? `, and its run of ${seat.activeRun.agentName} is cancelled` : ''}. To
          use it again, connect it with a new code.
        </D.DialogDescription>
        {action.error && (
          <p role="alert" className="text-failed">
            {action.error}
          </p>
        )}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="quiet">Cancel</Button>
          </D.DialogClose>
          <Button
            variant="danger"
            disabled={action.busy}
            onClick={() =>
              void action.run(() => api(`/api/seats/${seat?.id}`, { method: 'DELETE' }))
            }
          >
            Revoke seat
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}
