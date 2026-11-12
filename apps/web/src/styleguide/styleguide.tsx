import { Ellipsis } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AgentSheet, type AgentSheetProps } from '../agent-sheet/agent-sheet';
import { AppShell } from '../shell/app-shell';
import { gutter, PageHeader } from '../shell/page-header';
import { EmptyState, ErrorState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Chip } from '../ui/chip';
import { cn } from '../ui/cn';
import { Combobox } from '../ui/combobox';
import * as D from '../ui/dialog';
import * as M from '../ui/dropdown-menu';
import { Input, Textarea } from '../ui/input';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { DateField } from '../ui/calendar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Status, type RunStatus } from '../ui/status';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { backendDeveloper, newAgent, runs, shell } from './mock';

// Swatches read the live tokens: the page shows whichever theme is on (account menu).
const colors: [string, string, string][] = [
  ['Paper', '--bg', 'The page panel, tables, the agent sheet'],
  ['Desk', '--bg-sunken', 'The ground: sidebar, around the panel, dialog scrim'],
  ['Rule', '--line', 'Hairlines between rows and regions'],
  ['Pencil', '--ink-2', 'Secondary text, column headers, done runs'],
  ['Ink', '--ink', 'Text, primary buttons, focus ring'],
  ['Sign-off', '--accent', 'The approve button, a picked control, ask owner'],
  ['Running', '--running', 'An agent working'],
  ['Waiting', '--waiting', 'An agent waiting for a person; the approvals count'],
  ['Review', '--review', 'A task waiting for review'],
  ['Done', '--done', 'A finished run or task'],
  ['Failed', '--failed', 'Something broken'],
  ['Raised', '--bg-raised', 'The sheet, fields and overlays; lifted in dark'],
  ['Hover', '--bg-hover', 'Hovered rows and menu items'],
  ['Control border', '--line-control', 'Fields, radios, selects: 3:1 on every surface'],
  ['Faint ink', '--ink-3', 'Time, captions, placeholders'],
];

const typeScale: [string, string, string, string][] = [
  ['Agent name', 'text-name', 'Backend developer', '24/30, 600. The sheet only'],
  ['Page title', 'text-title', 'Approvals', '20/28, 600'],
  ['Section', 'text-section', 'Tools & policies', '15/22, 600'],
  [
    'Reading',
    'text-read',
    'Reproduce the problem with a failing test first.',
    '14/22, at most 72ch',
  ],
  ['Interface', 'text-ui', 'Fix flaky retry test in payments-api', '13/20, 400 and 500'],
  ['Small', 'text-small text-ink-2', 'Updated by a run on 19 Oct, 14:02', '12/16, 400 and 500'],
  ['Mono', 'font-mono text-small', 'code_host.open_change_request', 'Literal strings only'],
  ['Cyrillic', 'text-ui', 'Мария Иванова, PAY-412: исправить тест повторов', 'Names stay in Plex'],
  ['Figures', 'text-ui', '$1,284.10   $112.40   12 min   412,118 tokens', 'Tabular by default'],
];

const buttons = [
  ['primary', 'Save changes', 'Primary, ink. One per screen'],
  ['secondary', 'Duplicate', 'Secondary, the default'],
  ['quiet', 'Discard', 'Quiet'],
  ['decision', 'Approve', 'Decision, Sign-off. Only where an agent waits for a person'],
  ['danger', 'Revoke access', 'Danger. Irreversible, always confirmed'],
] as const;

const policyRows: [string, string, string][] = [
  ['code_host.create_branch', 'Create a branch named agent/*', 'allow'],
  ['code_host.open_change_request', 'Open a merge request or pull request', 'ask'],
  ['jira.add_comment', 'Comment on an issue', 'ask'],
  ['git push to main, force-push', 'Enforced by the git proxy for every agent', 'deny'],
];

const access: [string, string][] = [
  ['Deputy', 'Runs and edits it while the owner is away'],
  ['Operator', 'Runs it on their computer'],
  ['Viewer', 'Reads the sheet and the history'],
];

const templates = ['Backend developer', 'QA engineer', 'Analyst', 'Tech writer', 'Reviewer'].map(
  (label) => ({ value: label.toLowerCase(), label }),
);

// Runs table columns: [label, column width, cell classes]. A column that gives way on narrow
// screens hides its <col> and its cells together, so the remaining cells keep their columns.
const runColumns: [string, string, string][] = [
  ['Status', 'w-38', ''],
  ['Task', '', ''],
  ['Agent', 'w-38', ''],
  ['Started by', 'w-29 max-xl:hidden', 'text-ink-2 max-xl:hidden'],
  ['Computer', 'w-28 max-2xl:hidden', 'text-ink-2 max-2xl:hidden'],
  ['Result', 'w-49 max-lg:hidden', 'text-ink-2 max-lg:hidden'],
  ['Duration', 'w-19', 'text-right'],
  ['Cost', 'w-17', 'text-right'],
];

export default function Styleguide() {
  const [template, setTemplate] = useState<string | null>('backend developer');
  const [day, setDay] = useState<Date>();
  return (
    <AppShell data={shell}>
      <PageHeader
        title="Styleguide"
        crumbs={[{ label: 'Help', to: '/help' }]}
        actions={<span className="text-ink-2">Development builds only</span>}
      />
      <div className={cn('max-w-350 pb-24', gutter)}>
        <Section
          title="Color"
          lead="Paper and ink, and colour that always means one thing: a state, or a project's own colour. Orange is what waits for a person, so it is that person's to-do list."
        >
          <ul className="grid gap-x-10 gap-y-3 xl:grid-cols-2">
            {colors.map(([name, token, use]) => (
              <li key={token} className="flex items-center gap-3">
                <span
                  className="h-8 w-14 shrink-0 rounded-sm inset-ring inset-ring-line-strong"
                  style={{ background: `var(${token})` }}
                />
                <span>
                  <span className="font-medium">{name}</span>{' '}
                  <code className="text-ink-3">{token}</code>
                  <span className="block text-ink-2">{use}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Type"
          lead="IBM Plex Sans for everything, IBM Plex Mono only for strings you could paste into a terminal or a config file. Both are bundled with the app; figures are tabular."
        >
          {typeScale.map(([role, className, sample, meta]) => (
            <div
              key={role}
              className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-6 border-b border-line py-3.5 xl:grid-cols-[160px_minmax(0,1fr)_200px]"
            >
              <span className="text-ink-2">{role}</span>
              <span className={cn('whitespace-pre-wrap', className)}>{sample}</span>
              <span className="text-ink-3 max-xl:hidden">{meta}</span>
            </div>
          ))}
        </Section>

        <Section
          title="Controls"
          lead="32 px controls with a 6 px radius. Field and radio borders meet 3:1, so a field reads as a field. Focus is a solid ink ring with a 2 px gap. Nothing here is a native select, date picker or confirm."
        >
          <div className="flex flex-wrap items-start gap-x-8 gap-y-6">
            {buttons.map(([variant, label, note]) => (
              <Spec key={variant} note={note}>
                <Button variant={variant}>{label}</Button>
              </Spec>
            ))}
            <Spec note="Disabled">
              <Button variant="primary" disabled>
                Save changes
              </Button>
            </Spec>
            <Spec note="Small, 28 px">
              <Button size="sm">Add skill</Button>
            </Spec>
          </div>

          <div className="mt-10 grid gap-x-10 gap-y-7 xl:grid-cols-3">
            <Field label="Name" id="sg-name">
              <Input id="sg-name" defaultValue="Backend developer" />
            </Field>
            <Field label="Name, with an error" id="sg-taken">
              <Input
                id="sg-taken"
                defaultValue="Reviewer"
                aria-invalid="true"
                aria-describedby="sg-taken-error"
              />
              <p id="sg-taken-error" className="text-small text-failed">
                Another agent is already called Reviewer. Use a different name.
              </p>
            </Field>
            <Field label="Model" id="sg-model">
              <Select defaultValue="sonnet">
                <SelectTrigger id="sg-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sonnet">Sonnet 5.5</SelectItem>
                  <SelectItem value="opus">Opus 5.5</SelectItem>
                  <SelectItem value="default" description="What Claude Code uses on that computer">
                    Computer default
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Template, with search" id="sg-template">
              <Combobox
                id="sg-template"
                options={templates}
                value={template}
                onValueChange={setTemplate}
                placeholder="Choose a template"
                searchPlaceholder="Search templates"
                emptyText="No template matches that."
              />
            </Field>
            <Field label="A day, or none: the kit's own calendar" id="sg-day">
              <DateField
                id="sg-day"
                value={day}
                onChange={setDay}
                placeholder="No day"
                clearLabel="No day"
              />
            </Field>
            <Field label="Access, the quiet select of dense tables" id="sg-access">
              <Select defaultValue="Deputy">
                <SelectTrigger id="sg-access" variant="quiet" size="sm" className="w-34">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {access.map(([level, description]) => (
                    <SelectItem key={level} value={level} description={description}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Segmented tabs and a chip">
              <div className="flex flex-wrap items-center gap-3">
                <Tabs defaultValue="write">
                  <TabsList aria-label="Instructions view">
                    <TabsTrigger value="write">Write</TabsTrigger>
                    <TabsTrigger value="preview">Preview</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Chip>
                  Test-driven fix<span className="text-ink-3">1.4.0</span>
                </Chip>
              </div>
            </Field>
            <Field label="Checkbox, with its label beside it">
              <label className="flex items-center gap-2.5">
                <Checkbox defaultChecked />
                Run now
              </label>
            </Field>
            <Field label="Instructions, the markdown source" id="sg-instructions" wide>
              <Textarea
                id="sg-instructions"
                rows={4}
                className="font-mono text-small leading-5"
                defaultValue={
                  'You are the backend developer for the Payments team.\n\n## How you work\n- Reproduce a bug with a failing test first, then fix it.'
                }
              />
            </Field>
          </div>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <D.Dialog>
              <D.DialogTrigger asChild>
                <Button>Transfer ownership</Button>
              </D.DialogTrigger>
              <D.DialogContent>
                <D.DialogTitle>Transfer Backend developer to Ilya Smirnov?</D.DialogTitle>
                <D.DialogDescription>
                  Ilya becomes the owner. You keep viewer access and can no longer change or run the
                  agent.
                </D.DialogDescription>
                <D.DialogFooter>
                  <D.DialogClose asChild>
                    <Button variant="quiet">Cancel</Button>
                  </D.DialogClose>
                  <D.DialogClose asChild>
                    <Button variant="primary">Transfer ownership</Button>
                  </D.DialogClose>
                </D.DialogFooter>
              </D.DialogContent>
            </D.Dialog>
            <M.DropdownMenu>
              <M.DropdownMenuTrigger asChild>
                <Button size="icon" aria-label="More actions">
                  <Ellipsis />
                </Button>
              </M.DropdownMenuTrigger>
              <M.DropdownMenuContent align="start">
                <M.DropdownMenuItem>Duplicate</M.DropdownMenuItem>
                <M.DropdownMenuItem>Export</M.DropdownMenuItem>
                <M.DropdownMenuSeparator />
                <M.DropdownMenuItem variant="danger">Archive</M.DropdownMenuItem>
              </M.DropdownMenuContent>
            </M.DropdownMenu>
            <Button
              onClick={() =>
                toast.error("Couldn't save changes", {
                  description:
                    "The server didn't respond in 10 s. Your edits are still here; save again.",
                })
              }
            >
              Show an error toast
            </Button>
          </div>
        </Section>

        <Section
          title="Policy matrix"
          lead="Three columns of radios instead of a select in every row, so the shape of an agent's freedom shows at once. The Ask owner column is Sign-off."
        >
          <div className="max-w-140">
            <div
              aria-hidden="true"
              className="grid h-8 grid-cols-[1fr_repeat(3,88px)] items-center justify-items-center border-b border-line text-small font-medium text-ink-2"
            >
              <span className="justify-self-start">Tool</span>
              <span>Allow</span>
              <span>Ask owner</span>
              <span>Deny</span>
            </div>
            {policyRows.map(([tool, action, value]) => (
              <RadioGroup
                key={tool}
                defaultValue={value}
                disabled={value === 'deny'}
                aria-label={tool}
                className="grid min-h-12 grid-cols-[1fr_repeat(3,88px)] items-center justify-items-center border-b border-line py-1.5"
              >
                <span className="justify-self-start">
                  <code className="block">{tool}</code>
                  <span className="text-small text-ink-2">{action}</span>
                </span>
                <RadioGroupItem value="allow" aria-label="Allow" />
                <RadioGroupItem value="ask" tone="ask" aria-label="Ask owner" />
                <RadioGroupItem value="deny" aria-label="Deny" />
              </RadioGroup>
            ))}
          </div>
        </Section>

        <Section
          title="Runs table"
          lead="All six run statuses: a marker shape and a word, never a pill. Done is quiet; color marks what is alive, waiting for a person or broken. 36 px rows, one line per cell; narrow screens drop Computer, then Started by, then Result."
        >
          <Table className="-mx-3 w-[calc(100%+24px)] table-fixed">
            <colgroup>
              {runColumns.map(([label, width]) => (
                <col key={label} className={width} />
              ))}
            </colgroup>
            <thead>
              <TableRow>
                {runColumns.map(([label, , className]) => (
                  <TableHead key={label} className={className}>
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </thead>
            <tbody>
              {runs.map(([status, key, ...cells]) => (
                <TableRow key={cells[0]} className="hover:bg-hover">
                  <TableCell>
                    <Status status={status as RunStatus} />
                  </TableCell>
                  {cells.map((cell, i) => (
                    <TableCell key={i} className={runColumns[i + 1]?.[2]}>
                      {i === 0 && key && <span className="mr-1.5 text-ink-2">{key}</span>}
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </tbody>
          </Table>
        </Section>

        <Section
          title="Agent sheet"
          lead="One component, two densities. The pass is the default; below 360 px of panel width, or when the pass is taller than the window, the same data folds into rows. Nobody picks the density."
        >
          <div className="flex flex-wrap items-start gap-10">
            <SheetSpec id="sheet-pass" className="w-96" agent={backendDeveloper}>
              Pass, 384 px. One unsaved change: commenting in Jira moved from Allow to Ask owner.
            </SheetSpec>
            <SheetSpec id="sheet-compact" className="w-80" agent={backendDeveloper}>
              Compact, 320 px. The same data, details on click.
            </SheetSpec>
            <SheetSpec id="sheet-new" className="w-96" agent={newAgent}>
              A new agent: never run, not shared, no skills.
            </SheetSpec>
          </div>
        </Section>

        <Section
          title="Empty, loading and error"
          lead="Every list has all three. Empty says what the place is and the first thing to do; loading keeps the shape of the table; an error says what happened and what to do, without apologizing."
        >
          <div className="grid items-start gap-10 xl:grid-cols-3">
            <EmptyState
              title="No agents yet"
              action={<Button variant="primary">Create agent</Button>}
            >
              Create an agent from a role template, then give it instructions, tools and a budget.
            </EmptyState>
            <LoadingState label="Loading runs" />
            <ErrorState title="Couldn't load runs" onRetry={() => undefined}>
              The server didn't respond in 10 s. Retry, or tell your admin if it keeps failing.
            </ErrorState>
          </div>
        </Section>
      </div>
    </AppShell>
  );
}

function Section({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section className="pt-14">
      <h2 className="text-title">{title}</h2>
      <p className="mt-1 mb-7 max-w-[72ch] text-read text-ink-2">{lead}</p>
      {children}
    </section>
  );
}

function Spec({ note, children }: { note: string; children: ReactNode }) {
  return (
    <figure className="grid justify-items-start gap-2">
      {children}
      <figcaption className="max-w-[28ch] text-small text-ink-3">{note}</figcaption>
    </figure>
  );
}

function Field(props: { label: string; id?: string; wide?: boolean; children: ReactNode }) {
  // A label only for a real form control; the tabs specimen names itself with aria-label.
  const Label = props.id ? 'label' : 'span';
  return (
    <div
      className={cn('grid max-w-90 content-start gap-1.5', props.wide && 'max-w-140 xl:col-span-2')}
    >
      <Label htmlFor={props.id} className="font-medium">
        {props.label}
      </Label>
      {props.children}
    </div>
  );
}

function SheetSpec(props: {
  id: string;
  className: string;
  agent: AgentSheetProps;
  children: ReactNode;
}) {
  return (
    <figure data-testid={props.id} className={props.className}>
      <AgentSheet {...props.agent} />
      <figcaption className="mt-2 text-small text-ink-3">{props.children}</figcaption>
    </figure>
  );
}
