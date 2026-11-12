import { GitBranch, Hand, Plus, UsersRound, Wallet, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, asApiError } from '../api';
import type { TeamSummary } from '../teams/teams-data';
import { Button } from '../ui/button';
import { fieldChip } from '../ui/chip';
import { cn } from '../ui/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { HostGlyph } from '../ui/host-glyph';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { tintOf } from '../ui/tint';
import { NewTaskDialog } from '../tasks/new-task-dialog';
import { place, type ProjectView, repositoryName } from './projects-data';
import { useEnterprise } from '../admin/license-data';

const NONE = 'none';

type Intake = ProjectView['intake'];

/**
 * The project's fields as Linear's chips: the team that takes its tasks
 * and whether its lead starts at once, each a menu for an admin; the main repository; and each
 * connection, as the account its agents act as.
 */
export function ProjectFields(props: {
  project: ProjectView;
  isAdmin: boolean;
  onSaved: (project: ProjectView) => void;
}) {
  const { project, isAdmin } = props;
  const free = useEnterprise() === false;
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  useEffect(() => {
    if (!isAdmin) return;
    api<{ teams: TeamSummary[] }>('/api/teams').then(
      (data) => setTeams(data.teams),
      () => setTeams([]),
    );
  }, [isAdmin]);

  async function change(
    changes: { teamId?: string | null; intake?: Intake; usdPerMonth?: number | null },
    failed: string,
  ) {
    try {
      props.onSaved(
        await api<ProjectView>(`/api/projects/${project.id}`, { method: 'PATCH', body: changes }),
      );
    } catch (caught) {
      toast.error(failed, { description: asApiError(caught).message });
    }
  }

  const team = project.team;
  const main = project.repositories[0];
  const intakes = team && {
    manual: {
      icon: Hand,
      chip: 'A person starts it',
      title: 'A person starts it',
      text: 'A new task waits for someone to press Run.',
    },
    auto: {
      icon: Zap,
      chip: 'Lead starts at once',
      title: 'The lead takes it',
      text: `${team.lead.name} starts on a new task at once, on its owner's computer while it is connected.`,
    },
  };
  const intake = intakes?.[project.intake];
  const teamIcon = (
    <UsersRound aria-hidden="true" className={team ? tintOf(team.id) : 'text-ink-3'} />
  );
  return (
    <div className="flex flex-wrap gap-1.5">
      {isAdmin ? (
        <DropdownMenu>
          <DropdownMenuTrigger className={fieldChip} aria-label={`Team: ${team?.name ?? 'none'}`}>
            {teamIcon}
            <span className={cn('truncate', !team && 'text-ink-3')}>{team?.name ?? 'No team'}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Team that takes the tasks</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={team?.id ?? NONE}
              onValueChange={(value) =>
                void change({ teamId: value === NONE ? null : value }, "Couldn't change the team")
              }
            >
              <DropdownMenuRadioItem value={NONE}>No team</DropdownMenuRadioItem>
              {teams.map((each) => (
                <DropdownMenuRadioItem key={each.id} value={each.id}>
                  {each.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        team && (
          <Link to={`/teams/${team.id}`} className={fieldChip}>
            {teamIcon}
            <span className="truncate">{team.name}</span>
          </Link>
        )
      )}
      {intakes && intake && (
        <IntakeChip
          intake={intake}
          disabled={!isAdmin}
          menu={
            <DropdownMenuRadioGroup
              value={project.intake}
              onValueChange={(value) =>
                void change({ intake: value as Intake }, "Couldn't change who starts a task")
              }
            >
              {(['manual', 'auto'] as const).map((value) => (
                <DropdownMenuRadioItem key={value} value={value} className="items-start">
                  <span className="grid gap-0.5 py-0.5">
                    <span>{intakes[value].title}</span>
                    <span className="text-small text-ink-3">{intakes[value].text}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          }
        />
      )}
      <BudgetChip
        budget={project.budget}
        disabled={!isAdmin}
        free={free}
        onSave={(usdPerMonth) => change({ usdPerMonth }, "Couldn't change the monthly limit")}
      />
      {main && (
        <a href={main} target="_blank" rel="noreferrer" className={fieldChip} title={main}>
          <GitBranch aria-hidden="true" className="text-ink-2" />
          <span className="truncate">{repositoryName(main)}</span>
        </a>
      )}
      {project.connections.map((connection) => (
        <span key={connection.id} className={fieldChip}>
          <HostGlyph host={connection.kind} />
          <span className="truncate">
            {connection.kind !== 'jira' && connection.accountLogin ? (
              <>
                <span className="text-ink-3">Acts as</span> {connection.accountLogin}
              </>
            ) : (
              place(connection)
            )}
            {/* An agent's own token says whose it is. */}
            {connection.agentName && (
              <span className="text-ink-3"> for {connection.agentName}</span>
            )}
          </span>
        </span>
      ))}
    </div>
  );
}

/** When the lead starts: a menu for an admin, the value alone for anyone else. */
function IntakeChip(props: {
  intake: { icon: typeof Zap; chip: string };
  disabled: boolean;
  menu: React.ReactNode;
}) {
  const Icon = props.intake.icon;
  const face = (
    <>
      <Icon aria-hidden="true" className={Icon === Zap ? 'text-review' : 'text-ink-2'} />
      <span className="truncate">{props.intake.chip}</span>
    </>
  );
  if (props.disabled) return <span className={fieldChip}>{face}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={fieldChip}
        aria-label={`Who starts a task: ${props.intake.chip}`}
      >
        {face}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-32px)]">
        <DropdownMenuLabel>Who starts a new task</DropdownMenuLabel>
        {props.menu}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** New task, filed in the project: the composer of Tasks with the project, and so its team. */
export function NewProjectTask({ project }: { project: ProjectView }) {
  const [open, setOpen] = useState(false);
  return (
    <NewTaskDialog
      open={open}
      onOpenChange={setOpen}
      project={project}
      trigger={
        <Button variant="primary">
          <Plus aria-hidden="true" className="size-3.5" />
          New task
        </Button>
      }
    />
  );
}

const money = (usd: number) => usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * The project's month in money: what its tasks' runs cost against its limit, which its
 * maker or an admin sets; at the limit no new run of its tasks starts.
 */
function BudgetChip(props: {
  budget: ProjectView['budget'];
  disabled: boolean;
  /** Free without a key: a monthly limit needs one. */
  free: boolean;
  onSave: (usdPerMonth: number | null) => Promise<void>;
}) {
  const { usdPerMonth, usdThisMonth } = props.budget;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const value = text.trim() === '' ? null : Number(text.replace(/[\s,$]/g, ''));
  const wrong = value !== null && !(value > 0 && value <= 1_000_000);
  // On Free a limit can be taken off but not set.
  const locked = props.free && usdPerMonth === null;
  const label =
    usdPerMonth === null
      ? usdThisMonth > 0
        ? `${money(usdThisMonth)} this month`
        : 'No monthly limit'
      : `${money(usdThisMonth)} of ${money(usdPerMonth)} a month`;
  const reached = usdPerMonth !== null && usdThisMonth >= usdPerMonth;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setText(usdPerMonth === null ? '' : String(usdPerMonth));
      }}
    >
      <PopoverTrigger
        disabled={props.disabled}
        aria-label={`Monthly limit: ${label}`}
        className={cn(fieldChip, reached && 'border-failed/50 text-failed')}
      >
        <Wallet aria-hidden="true" className={reached ? 'text-failed' : 'text-ink-2'} />
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent aria-label="Monthly limit" className="grid w-72 gap-2 p-3">
        <label htmlFor="project-limit" className="font-medium">
          Monthly limit, USD
        </label>
        <Input
          id="project-limit"
          inputMode="decimal"
          placeholder="No limit"
          value={text}
          disabled={locked}
          aria-invalid={wrong || undefined}
          onChange={(event) => setText(event.target.value)}
        />
        <p className={cn('text-small', wrong ? 'text-failed' : 'text-ink-3')}>
          {locked
            ? 'A monthly limit needs a license key.'
            : wrong
              ? 'A number above 0, up to 1,000,000.'
              : 'At the limit no new run of the project’s tasks starts. Empty is no limit.'}
        </p>
        <Button
          variant="primary"
          disabled={wrong || locked}
          onClick={() => void props.onSave(value).then(() => setOpen(false))}
        >
          Save
        </Button>
      </PopoverContent>
    </Popover>
  );
}
