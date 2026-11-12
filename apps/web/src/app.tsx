import { LucideProvider } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AdminPage } from './admin/admin-page';
import { ConnectionsPage } from './admin/connections-page';
import { LicensePage } from './admin/license-page';
import { LogsPage, TracePage } from './admin/logs-page';
import { ModelsPage } from './admin/models-page';
import { PeoplePage } from './admin/people-page';
import { SeatsPage } from './admin/seats-page';
import { AgentEditorPage } from './agents/agent-editor';
import { AgentsPage } from './agents/agents-page';
import { ApprovalsPage } from './approvals/approvals-page';
import { InvitePage } from './auth/invite-page';
import { LoginPage } from './auth/login-page';
import { ResetPage } from './auth/reset-page';
import { SetupPage } from './auth/setup-page';
import { DashboardPage } from './dashboard/dashboard-page';
import { ProjectPage } from './projects/project-page';
import { ProjectsPage } from './projects/projects-page';
import { AccountPage } from './settings/account-page';
import { ApiTokensPage } from './settings/api-tokens-page';
import { NotificationsPage } from './settings/notifications-page';
import { RunsPage } from './runs/runs-page';
import { SessionShell } from './session';
import { frame, PageHeader } from './shell/page-header';
import { LibraryPage } from './library/library-page';
import { footerSections, mainSections, SectionPage } from './shell/sections';
import { EmptyState, ErrorState } from './shell/states';
import { TaskPage } from './tasks/task-page';
import { TeamPage } from './teams/team-page';
import { TeamsPage } from './teams/teams-page';
import { TasksPage } from './tasks/tasks-page';
import { Toaster } from './ui/sonner';
import { TooltipProvider } from './ui/tooltip';
import { HelpPage } from './help/help-page';
import { MorePage } from './shell/more-page';

// The styleguide exists only in dev builds: the condition is false in production, so Vite
// drops the import and the page never ships.
const Styleguide = import.meta.env.DEV ? lazy(() => import('./styleguide/styleguide')) : null;
// The run page renders markdown, a fifth of the app's code: it loads when a run opens.
// A tab opened before a deploy asks for a chunk that is gone: it says so instead of going blank.
const RunPage = lazy(() =>
  import('./runs/run-page').then(
    ({ RunPage }) => ({ default: RunPage }),
    () => ({ default: StalePage }),
  ),
);

// Sections that have a page of their own; the others show their empty state.
const pages: Record<string, ReactNode> = {
  '/': <DashboardPage />,
  '/admin': <AdminPage />,
  '/approvals': <ApprovalsPage />,
  '/agents': <AgentsPage />,
  '/tasks': <TasksPage />,
  '/teams': <TeamsPage />,
  '/projects': <ProjectsPage />,
  '/runs': <RunsPage />,
  '/library': <LibraryPage />,
  '/help': <HelpPage />,
};

export function App() {
  return (
    <LucideProvider size={16} strokeWidth={1.5}>
      <TooltipProvider delayDuration={300}>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/reset-password" element={<ResetPage />} />
          <Route element={<SessionShell />}>
            {[...mainSections, ...footerSections].map((section) => (
              <Route
                key={section.path}
                path={section.path}
                element={pages[section.path] ?? <SectionPage section={section} />}
              />
            ))}
            <Route path="/more" element={<MorePage />} />
            <Route path="/settings/account" element={<AccountPage />} />
            <Route path="/settings/api-tokens" element={<ApiTokensPage />} />
            <Route path="/settings/notifications" element={<NotificationsPage />} />
            <Route path="/agents/:id" element={<AgentEditorPage />} />
            <Route path="/tasks/:id" element={<TaskPage />} />
            <Route path="/teams/:id" element={<TeamPage />} />
            <Route path="/admin/people" element={<PeoplePage />} />
            <Route path="/admin/computers" element={<SeatsPage />} />
            {/* The page's earlier name: old links still land on it. */}
            <Route path="/admin/seats" element={<Navigate to="/admin/computers" replace />} />
            <Route path="/admin/connections" element={<ConnectionsPage />} />
            <Route path="/admin/models" element={<ModelsPage />} />
            <Route path="/admin/license" element={<LicensePage />} />
            <Route path="/admin/logs" element={<LogsPage />} />
            <Route path="/admin/logs/traces/:id" element={<TracePage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route
              path="/runs/:id"
              element={
                <Suspense
                  fallback={<PageHeader title="Run" crumbs={[{ label: 'Runs', to: '/runs' }]} />}
                >
                  <RunPage />
                </Suspense>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Route>
          {Styleguide && (
            <Route
              path="/styleguide"
              element={
                <Suspense>
                  <Styleguide />
                </Suspense>
              }
            />
          )}
        </Routes>
        <Toaster />
      </TooltipProvider>
    </LucideProvider>
  );
}

function StalePage() {
  return (
    <>
      <PageHeader title="Page didn't load" />
      <div className={frame.wide}>
        <ErrorState title="This page didn't load" onRetry={() => window.location.reload()}>
          Agentome was updated since this tab opened, or the network dropped. Retry reloads it.
        </ErrorState>
      </div>
    </>
  );
}

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState title="This address has no page">
        Check the link you followed, or pick a page in the sidebar.
      </EmptyState>
    </>
  );
}
