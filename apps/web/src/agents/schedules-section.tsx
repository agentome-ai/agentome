import { CalendarClock, Ellipsis, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { type ApiError, api, asApiError, fieldErrors, formatDate } from '../api';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Combobox } from '../ui/combobox';
import * as D from '../ui/dialog';
import * as M from '../ui/dropdown-menu';
import { Field, FormError } from '../ui/field';
import { Input, Textarea } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';

// An agent's recurring tasks: "every weekday at 09:00" makes a task in one of its projects and
// runs it. On a computer the run waits for its owner to be at the computer; on the server it runs
// at once.

type Schedule = {
  id: string;
  title: string;
  body: string;
  days: number[];
  time: string;
  timeZone: string;
  enabled: boolean;
  when: string;
  lastRunAt: string | null;
};

const DAYS: [number, string][] = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];
/** Every half hour: a menu, not the browser's own time field. */
const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
);
const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [here];
  }
})();

type Project = { id: string; name: string };

export function SchedulesSection({ agentId, projects }: { agentId: string; projects: Project[] }) {
  const [schedules, setSchedules] = useState<Schedule[]>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const url = `/api/agents/${agentId}/schedules`;

  const load = useCallback(() => {
    api<{ schedules: Schedule[] }>(url).then(
      (data) => setSchedules(data.schedules),
      (caught) => setError(asApiError(caught).message),
    );
  }, [url]);
  useEffect(load, [load]);

  async function change(schedule: Schedule, body: Partial<Schedule> | null) {
    try {
      if (body === null) {
        await api(`${url}/${schedule.id}`, { method: 'DELETE' });
        setSchedules((was) => was?.filter((s) => s.id !== schedule.id));
      } else {
        const next = await api<Schedule>(`${url}/${schedule.id}`, { method: 'PATCH', body });
        setSchedules((was) => was?.map((s) => (s.id === next.id ? next : s)));
      }
    } catch (caught) {
      toast.error("Couldn't change the schedule", { description: asApiError(caught).message });
    }
  }

  if (error) return <p className="text-failed">{error}</p>;
  if (!schedules) return <p className="text-ink-3">Loading the schedules…</p>;
  return (
    <div className="grid gap-3">
      {schedules.length === 0 ? (
        <p className="text-ink-2">
          No recurring tasks. Add one, and the agent gets its task on the days and at the time you
          pick.
        </p>
      ) : (
        <ul aria-label="Schedules" className="divide-y divide-line rounded-lg border border-line">
          {schedules.map((schedule) => (
            <li key={schedule.id} className="flex items-center gap-3 px-4 py-3">
              <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
              <span
                className={cn('grid min-w-0 flex-1 gap-0.5', !schedule.enabled && 'opacity-60')}
              >
                <span className="truncate font-medium">{schedule.title}</span>
                <span className="truncate text-small text-ink-3">
                  {schedule.when}, {schedule.timeZone}
                  {schedule.lastRunAt && `; last ${formatDate(schedule.lastRunAt)}`}
                </span>
              </span>
              <Switch
                aria-label={`${schedule.title}: on`}
                checked={schedule.enabled}
                onCheckedChange={(on) => void change(schedule, { enabled: on })}
              />
              <M.DropdownMenu>
                <M.DropdownMenuTrigger asChild>
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label={`Actions for ${schedule.title}`}
                  >
                    <Ellipsis />
                  </Button>
                </M.DropdownMenuTrigger>
                <M.DropdownMenuContent align="end">
                  <M.DropdownMenuItem variant="danger" onSelect={() => void change(schedule, null)}>
                    Remove
                  </M.DropdownMenuItem>
                </M.DropdownMenuContent>
              </M.DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" className="size-3.5" />
          New schedule
        </Button>
      </div>
      <D.Dialog open={adding} onOpenChange={setAdding}>
        <D.DialogContent>
          {adding && (
            <NewSchedule
              url={url}
              projects={projects}
              onMade={(made) => {
                setSchedules((was) => [...(was ?? []), made]);
                setAdding(false);
              }}
            />
          )}
        </D.DialogContent>
      </D.Dialog>
    </div>
  );
}

function NewSchedule(props: {
  url: string;
  projects: Project[];
  onMade: (schedule: Schedule) => void;
}) {
  // Its tasks are filed in a project of the agent's, as every task is.
  const [projectId, setProjectId] = useState(props.projects[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [time, setTime] = useState('09:00');
  const [timeZone, setTimeZone] = useState(here);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const daysId = useId();
  const fields = error ? fieldErrors(error) : {};

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      props.onMade(
        await api<Schedule>(props.url, {
          body: { projectId, title, body, days, time, timeZone },
        }),
      );
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  if (props.projects.length === 0) {
    return (
      <div className="grid gap-4">
        <D.DialogTitle>New schedule</D.DialogTitle>
        <D.DialogDescription>
          Every task is filed in a project, and this agent is on none yet.{' '}
          <Link to="/projects" className="font-medium text-ink underline underline-offset-2">
            Add it to a project
          </Link>
          , then schedule its tasks.
        </D.DialogDescription>
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button type="button">Close</Button>
          </D.DialogClose>
        </D.DialogFooter>
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void save(event)} noValidate className="grid gap-4">
      <D.DialogTitle>New schedule</D.DialogTitle>
      <D.DialogDescription>
        On these days and at this time the agent gets this task, as if someone filed it.
      </D.DialogDescription>
      <Field label="Project" error={fields.projectId}>
        {(control) => (
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {props.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      <Field label="Task" error={fields.title}>
        {(control) => (
          <Input
            {...control}
            autoFocus
            placeholder="Write the weekly release notes"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        )}
      </Field>
      <Field label="What to do" hint="Markdown, it goes to the agent as it is.">
        {(control) => (
          <Textarea {...control} value={body} onChange={(event) => setBody(event.target.value)} />
        )}
      </Field>
      <div className="grid gap-1.5">
        <span id={daysId} className="font-medium">
          Days
        </span>
        <div role="group" aria-labelledby={daysId} className="flex flex-wrap gap-1.5">
          {DAYS.map(([day, name]) => {
            const on = days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setDays((was) => (on ? was.filter((d) => d !== day) : [...was, day]))
                }
                className={cn(
                  'h-8 min-w-11 rounded-md border px-2 text-ui',
                  on ? 'border-ink bg-selected font-medium' : 'border-line-strong text-ink-2',
                )}
              >
                {name}
              </button>
            );
          })}
        </div>
        {fields.days && <p className="text-small text-failed">{fields.days}</p>}
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label="Time">
          {(control) => (
            <Select value={time} onValueChange={setTime}>
              <SelectTrigger {...control} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <div className="grid min-w-60 flex-1 gap-1.5">
          <span className="font-medium">Time zone</span>
          <Combobox
            options={zones.map((zone) => ({ value: zone, label: zone }))}
            value={timeZone}
            onValueChange={setTimeZone}
            placeholder="Time zone"
            searchPlaceholder="Find a zone"
            emptyText="No such zone"
          />
        </div>
      </div>
      {error && Object.keys(fields).length === 0 && <FormError>{error.message}</FormError>}
      <D.DialogFooter>
        <D.DialogClose asChild>
          <Button variant="quiet" type="button">
            Cancel
          </Button>
        </D.DialogClose>
        <Button
          variant="primary"
          type="submit"
          disabled={pending || title.trim() === '' || days.length === 0}
        >
          Add schedule
        </Button>
      </D.DialogFooter>
    </form>
  );
}
