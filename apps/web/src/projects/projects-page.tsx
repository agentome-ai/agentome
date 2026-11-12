import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type ApiError, api, asApiError, fieldErrors, formatDate } from '../api';
import { ApiErrorState, useMe } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Input } from '../ui/input';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import type { ProjectSummary, ProjectView } from './projects-data';
import { Tint } from '../ui/tint';

/** Projects: what the company's agents work on, and what each one reaches. */
export function ProjectsPage() {
  const me = useMe();
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [error, setError] = useState<ApiError>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setProjects((await api<{ projects: ProjectSummary[] }>('/api/projects')).projects);
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const isAdmin = me.role === 'admin';
  // Every person makes projects; connecting one to a code host stays an admin's.
  const newProject = <NewProjectDialog />;
  return (
    <>
      <PageHeader title="Projects" actions={projects?.length ? newProject : undefined} />
      <div className={cn(frame.wide, 'pt-4 pb-24')}>
        {error ? (
          <ApiErrorState title="Couldn't load projects" error={error} onRetry={load} />
        ) : !projects ? (
          <LoadingState label="Loading projects" />
        ) : projects.length === 0 ? (
          <EmptyState title="No projects yet" action={newProject}>
            {isAdmin
              ? 'A project gives its agents the repositories of a code host. Create one, then connect GitHub or GitLab to it.'
              : 'A project groups your agents’ work. Create one; an admin connects it to GitHub, GitLab or Jira.'}
          </EmptyState>
        ) : (
          <Table phoneList className="-mx-3 w-[calc(100%+24px)] table-fixed">
            <colgroup>
              <col />
              <col className="w-32" />
              <col className="w-32" />
              <col className="w-32 max-lg:hidden" />
            </colgroup>
            <thead>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Agents</TableHead>
                <TableHead className="text-right">Connections</TableHead>
                <TableHead className="text-right max-lg:hidden">Created</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {projects.map((project) => (
                <TableRow key={project.id} className="hover:bg-hover">
                  <TableCell primary className="font-medium">
                    <Link
                      to={`/projects/${project.id}`}
                      className="flex min-w-0 items-center gap-2"
                    >
                      <Tint id={project.id} kind="project" />
                      <span className="truncate">{project.name}</span>
                    </Link>
                  </TableCell>
                  <Count value={project.agentCount} noun="agent" />
                  <Count value={project.connectionCount} noun="connection" />
                  <TableCell className="text-right text-ink-2 max-lg:hidden">
                    {formatDate(project.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}

/**
 * A number that means something only when it is not zero; zero says so in words. A phone's list
 * has no column heads, so there the number says what it counts: "8 agents".
 */
const Count = ({ value, noun }: { value: number; noun: string }) => (
  <TableCell className={cn('text-right', value ? 'text-ink-2' : 'text-ink-3')}>
    <span className="max-md:hidden">{value || 'None'}</span>
    <span className="md:hidden">
      {value ? `${value} ${noun}${value === 1 ? '' : 's'}` : `No ${noun}s`}
    </span>
  </TableCell>
);

/** New project: a name now, its description and connections on the page it opens. */
function NewProjectDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const project = await api<ProjectView>('/api/projects', { method: 'POST', body: { name } });
      setOpen(false);
      await navigate(`/projects/${project.id}`);
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName('');
          setError(undefined);
        }
      }}
    >
      <D.DialogTrigger asChild>
        <Button size="sm">New project</Button>
      </D.DialogTrigger>
      <D.DialogContent>
        <form onSubmit={(event) => void create(event)} noValidate>
          <D.DialogTitle>New project</D.DialogTitle>
          <D.DialogDescription>
            Name it after the work, not the repository: one project can reach several of them.
          </D.DialogDescription>
          <div className="grid gap-4 py-4">
            <Field label="Name" error={error && fieldErrors(error).name}>
              {(props) => (
                <Input
                  {...props}
                  autoFocus
                  value={name}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
            {error && !fieldErrors(error).name && <FormError>{error.message}</FormError>}
          </div>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </D.DialogClose>
            <Button type="submit" disabled={pending || name.trim() === ''}>
              Create project
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}
