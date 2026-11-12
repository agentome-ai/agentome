import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** A seat as GET /api/seats describes it. */
export type Seat = {
  id: string;
  name: string;
  /** Whose computer it is; the pages say the person, not the machine. */
  owner: { id: string; name: string };
  kind: 'subscription-laptop' | 'api-server' | 'local-model';
  status: 'active' | 'revoked';
  lastSeenAt: string | null;
  /** Minutes without a person at the computer after which it takes no runs; 5 to 120. */
  idleMinutes: number;
  activeRun: { id: string; agentName: string; startedAt: string | null } | null;
  /** What to run on the computer when its worker is older than the server's; null when it is not. */
  updateCommand: string | null;
  /** The engines that said at the computer's last claim that they are not signed in on it. */
  signedOut: ('claude-code' | 'codex')[];
  /** The system its worker named at its last claim, as Node names it (`win32`); null before. */
  platform: string | null;
  /**
   * `none`: it runs the agent's commands without a sandbox (Windows); `allowedAt`: since when an
   * admin has allowed that. Until then it takes no runs.
   */
  sandbox: { none: boolean; allowedAt: string | null };
};

/** A Windows computer that takes no runs until an admin allows it to run without a sandbox. */
export const waitsForSandbox = (seat: Pick<Seat, 'status' | 'sandbox'>) =>
  seat.status === 'active' && seat.sandbox.none && seat.sandbox.allowedAt === null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Whatever a request threw, as an ApiError with something to show. */
export const toApiError = (error: unknown) =>
  error instanceof ApiError ? error : new ApiError(String(error), 'internal');

/** JSON in and out; a failure becomes an ApiError with the server's own message. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = init.body ? { 'content-type': 'application/json' } : undefined;
  const response = await fetch(path, { ...init, headers }).catch(() => {
    throw new ApiError("The server didn't answer. Check your connection, then retry.", 'network');
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && body !== null) return body as T;
  const error = (body as { error?: { code: string; message: string } } | null)?.error;
  throw new ApiError(
    error?.message ??
      `The server answered ${response.status}. Retry, or tell your admin if it keeps failing.`,
    error?.code ?? 'internal',
  );
}

// A seat that claimed within this window is online: an idle seat claims every 25 s, a busy
// one sends a heartbeat every 30 s.
const ONLINE_MS = 2 * 60_000;
export const isOnline = (seat: Pick<Seat, 'status' | 'lastSeenAt'>, now = Date.now()) =>
  seat.status === 'active' &&
  seat.lastSeenAt !== null &&
  now - new Date(seat.lastSeenAt).getTime() < ONLINE_MS;

const ENGINES = { 'claude-code': 'Claude Code', codex: 'Codex' };

/**
 * What an online computer cannot run for want of a sign-in, as a line; null when there is
 * nothing to say. An offline computer's answer is as old as its last claim, so it is not shown.
 */
export function signedOutNote(seat: Pick<Seat, 'status' | 'lastSeenAt' | 'signedOut'>) {
  if (!isOnline(seat) || seat.signedOut.length === 0) return null;
  const names = seat.signedOut.map((engine) => ENGINES[engine]);
  return `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} not signed in`;
}

type SeatsState = { seats: Seat[] | null; error: ApiError | null; reload: () => Promise<void> };
const SeatsContext = createContext<SeatsState | null>(null);

// Runs start and end on their own, so the list refreshes itself.
const REFRESH_MS = 30_000;

/** The person's seats for the sidebar and the Seats page, loaded once and kept fresh. */
export function SeatsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SeatsState, 'reload'>>({ seats: null, error: null });
  const reload = useCallback(async () => {
    try {
      setState({ seats: await api<Seat[]>('/api/seats'), error: null });
    } catch (error) {
      setState((previous) => ({ ...previous, error: toApiError(error) }));
    }
  }, []);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  return <SeatsContext value={{ ...state, reload }}>{children}</SeatsContext>;
}

/** The person's computer as the New task dialog names it: the first active seat. */
export type OwnSeat = { name: string; activity: string; busy: boolean } | null;
export function sidebarSeat(seats: Seat[] | null): OwnSeat {
  const seat = seats?.find((candidate) => candidate.status === 'active');
  if (!seat) return null;
  if (seat.activeRun) {
    return { name: seat.name, activity: `Running ${seat.activeRun.agentName}`, busy: true };
  }
  const activity = signedOutNote(seat) ?? (isOnline(seat) ? 'Ready for runs' : 'Offline');
  return { name: seat.name, activity, busy: false };
}

export function useSeats(): SeatsState {
  const seats = useContext(SeatsContext);
  if (!seats) throw new Error('useSeats needs a SeatsProvider above it');
  return seats;
}
