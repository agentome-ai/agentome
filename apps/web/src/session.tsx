import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { type Location, Navigate, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { SeatsProvider } from './admin/seats-data';
import { AgentsProvider, sidebarStatus, useAgents } from './agents/agents-data';
import { ApprovalsProvider, useApprovals } from './approvals/approvals-data';
import { useTasksInWork } from './tasks/tasks-in-work';
import { type ApiError, api, asApiError, type Me } from './api';
import { AppShell, emptyShell } from './shell/app-shell';
import { forgetDevice } from './shell/push';
import { hideSplash } from './shell/splash';
import { ErrorState } from './shell/states';

const MeContext = createContext<Me | null>(null);

/** The signed-in person, inside the product shell. */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe() is only available inside SessionShell');
  return me;
}

// Sign-in brings the person back to the page that sent them there.
const signInFrom = (location: Location) =>
  `/login?next=${encodeURIComponent(location.pathname + location.search)}`;

/** A failed API call on a page. A session that ended meanwhile goes to sign-in instead. */
export function ApiErrorState(props: { title: string; error: ApiError; onRetry: () => void }) {
  const location = useLocation();
  if (props.error.code === 'unauthorized') return <Navigate to={signInFrom(location)} replace />;
  return (
    <ErrorState title={props.title} onRetry={props.onRetry}>
      {props.error.message}
    </ErrorState>
  );
}

/**
 * The product shell for a signed-in person. Without a session it sends the person to
 * sign-in and back here afterwards; before the setup, to /setup.
 */
export function SessionShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<ApiError>();

  const load = useCallback(() => {
    setError(undefined);
    api<Me>('/api/me').then(setMe, (caught) => setError(asApiError(caught)));
  }, []);
  useEffect(load, [load]);
  // The phone's splash covers the check; it goes once there is a shell, an error or a redirect.
  useEffect(() => {
    if (me || error) hideSplash();
  }, [me, error]);

  async function signOut() {
    try {
      await forgetDevice();
      await api('/api/auth/sign-out', { body: {} });
      navigate('/login', { replace: true });
    } catch (caught) {
      toast.error("Couldn't sign out", { description: asApiError(caught).message });
    }
  }

  if (error?.code === 'unauthorized') return <Navigate to={signInFrom(location)} replace />;
  if (error?.code === 'setup_required') return <Navigate to="/setup" replace />;
  if (error) {
    return (
      <main className="mx-auto max-w-110 px-4 pt-[12vh]">
        <ErrorState title="Couldn't open Agentome" onRetry={load}>
          {error.message}
        </ErrorState>
      </main>
    );
  }
  // Blank paper for the moment it takes to check the session: no flash of the shell.
  if (!me) return <div role="status" aria-label="Loading" className="min-h-dvh" />;
  // The person's computers and agents are asked for only once there is a session to ask with.
  return (
    <MeContext.Provider value={me}>
      <SeatsProvider>
        <AgentsProvider>
          <ApprovalsProvider>
            <ProductShell
              name={me.name}
              email={me.email}
              admin={me.role === 'admin'}
              onSignOut={signOut}
              onAccountSaved={load}
            />
          </ApprovalsProvider>
        </AgentsProvider>
      </SeatsProvider>
    </MeContext.Provider>
  );
}

/** The shell with what the API knows so far: the person, their computer and their agents. */
function ProductShell(props: {
  name: string;
  email: string;
  admin: boolean;
  onSignOut: () => void;
  onAccountSaved: () => void;
}) {
  const { agents } = useAgents();
  const { approvals } = useApprovals();
  const tasksInWork = useTasksInWork();
  const data = {
    ...emptyShell,
    approvalsWaiting: approvals?.length ?? 0,
    tasksInWork,
    user: { name: props.name, email: props.email, admin: props.admin },
    agents: agents.flatMap(({ id, name, lastRun }) => {
      const status = sidebarStatus(lastRun);
      if (!status || !lastRun) return [];
      // An agent at work opens its work: the run's task, or the run when it has none.
      const to = lastRun.taskId ? `/tasks/${lastRun.taskId}` : `/runs/${lastRun.id}`;
      return [{ id, name, status, to }];
    }),
  };
  return <AppShell data={data} onSignOut={props.onSignOut} onAccountSaved={props.onAccountSaved} />;
}
