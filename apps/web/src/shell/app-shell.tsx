import { ChevronDown, ChevronLeft, ChevronRight, CircleUserRound, Search } from 'lucide-react';
import * as React from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useTheme, type Theme } from '../theme';
import { cn } from '../ui/cn';
import * as C from '../ui/command';
import * as M from '../ui/dropdown-menu';
import { statusLabel, StatusMarker, type RunStatus } from '../ui/status';
import { Logo } from '../ui/logo';
import { Tooltip } from '../ui/tooltip';
import type { MoreContext } from './more-page';
import { PullToRefresh } from './pull-to-refresh';
import { footerSections, mainSections, paletteKey, type Section, tabPaths } from './sections';
import { TabIcon } from './tab-icons';
import { LicenseBanner } from './license-banner';

export type ShellData = {
  approvalsWaiting: number;
  /** The person's open tasks with a run going: a quiet count, nothing waits on them. */
  tasksInWork: number;
  /** `to`: what a click opens, the agent's work; its settings when there is none. */
  agents: { id: string; name: string; status?: RunStatus; to?: string }[];
  /** `admin`: the license banner sends an admin to Admin → License, anyone else to an admin. */
  user: { name: string; email?: string; admin?: boolean } | null;
};

/** Until the API exists (tasks 3 to 7) the product shell shows honest empty data. */
export const emptyShell: ShellData = {
  approvalsWaiting: 0,
  tasksInWork: 0,
  agents: [],
  user: null,
};

const agentsShown = 6;
// Below 1280 px the sidebar is always the icon rail; above it, [ or the button toggles it.
const narrowMedia = window.matchMedia('(width < 1280px)');
const subscribeNarrow = (onChange: () => void) => {
  narrowMedia.addEventListener('change', onChange);
  return () => narrowMedia.removeEventListener('change', onChange);
};
// [ is a character while typing, and belongs to the menu, list or dialog that has focus.
const keyIsTaken = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ['INPUT', 'TEXTAREA'].includes(target.tagName) ||
    target.closest('[role=menu], [role=listbox], [role=dialog]') !== null);

export function AppShell({
  data,
  onSignOut,
  onAccountSaved,
  children,
}: {
  data: ShellData;
  onSignOut?: () => void;
  onAccountSaved?: () => void;
  children?: React.ReactNode;
}) {
  const narrow = React.useSyncExternalStore(subscribeNarrow, () => narrowMedia.matches);
  const [collapsed, setCollapsed] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const rail = narrow || collapsed;
  const more: MoreContext = {
    data,
    tabPaths,
    onSearch: () => setPaletteOpen(true),
    onSignOut,
    onAccountSaved,
  };

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (
        event.key === '[' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !keyIsTaken(event.target)
      ) {
        // Below 1280 px the rail is forced: a hidden toggle would surprise on a wider window.
        if (!narrowMedia.matches) setCollapsed((was) => !was);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      {/* One ground for the sidebar and the page, a hairline between them. The window
          scrolls, so a run follows its tail by it. */}
      <div className="flex min-h-dvh bg-paper">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-ink px-3 py-1.5 text-ink-inverse focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <aside
          aria-label="Sidebar"
          className={cn(
            'sticky top-0 flex h-dvh shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r border-line bg-paper pt-3 pb-2.5 transition-[width] duration-180 ease-out max-md:hidden',
            rail ? 'w-14 px-2' : 'w-58 px-3 max-2xl:w-55 3xl:w-62',
          )}
        >
          <Sidebar
            data={data}
            rail={rail}
            onSearch={() => setPaletteOpen(true)}
            onSignOut={onSignOut}
            onAccountSaved={onAccountSaved}
          />
        </aside>
        {/* The toggle hangs on the sidebar's edge, halfway down: a zero-width column that sticks
            with the viewport, so the arrow stays put while the page scrolls. Not below 1280 px,
            where the rail is forced. */}
        {!narrow && (
          <div className="sticky top-0 z-10 h-dvh w-0 shrink-0">
            <Tooltip label={<Hint keys="[">{rail ? 'Expand sidebar' : 'Collapse sidebar'}</Hint>}>
              <button
                type="button"
                aria-label={`${rail ? 'Expand' : 'Collapse'} sidebar`}
                onClick={() => setCollapsed(!collapsed)}
                className="absolute top-1/2 -left-2.5 flex h-7 w-5 -translate-y-1/2 items-center justify-center rounded-md border border-line bg-raised text-ink-3 hover:border-line-strong hover:text-ink"
              >
                {rail ? (
                  <ChevronRight className="size-3.5" />
                ) : (
                  <ChevronLeft className="size-3.5" />
                )}
              </button>
            </Tooltip>
          </div>
        )}
        {/* On a phone the page ends above the tab bar, not under it. */}
        <main
          id="main"
          className="min-w-0 flex-1 bg-paper max-md:pb-[calc(56px+env(safe-area-inset-bottom))]"
        >
          {data.user && <LicenseBanner admin={data.user.admin === true} />}
          {children ?? <Outlet context={more} />}
        </main>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
      <TabBar waiting={data.approvalsWaiting} />
      <PullToRefresh />
    </>
  );
}

// The tab bar of an app: a press dims the tab, as a native one does.
const tabClass =
  'relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] leading-none font-medium text-ink-3 active:opacity-60 aria-[current=page]:font-semibold aria-[current=page]:text-ink';

function TabBar({ waiting }: { waiting: number }) {
  const { pathname } = useLocation();
  const onTab = tabPaths.some((path) =>
    path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`),
  );
  return (
    <nav
      aria-label="Tabs"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-paper/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      {mainSections
        .filter((section) => tabPaths.includes(section.path))
        .map((section) => {
          const count = section.path === '/approvals' ? waiting : 0;
          return (
            <NavLink
              key={section.path}
              to={section.path}
              end={section.path === '/'}
              aria-label={count > 0 ? `${section.label}, ${count} waiting` : undefined}
              className={tabClass}
            >
              {({ isActive }) => (
                <>
                  <TabIcon path={section.path} open={isActive} dot={count > 0} />
                  {section.label}
                </>
              )}
            </NavLink>
          );
        })}
      {/* More is where every page off the tab bar is reached from, so it stays lit there. */}
      <Link to="/more" aria-current={onTab ? undefined : 'page'} className={tabClass}>
        <TabIcon path="/more" open={!onTab} />
        More
      </Link>
    </nav>
  );
}

/** The sidebar's contents: in the aside, as the full sidebar or the icon rail, and in the phone's drawer. */
function Sidebar({
  data,
  rail,
  onSearch,
  onSignOut,
  onAccountSaved,
}: {
  data: ShellData;
  rail: boolean;
  onSearch: () => void;
  onSignOut?: () => void;
  onAccountSaved?: () => void;
}) {
  return (
    <>
      {/* The logo's row keeps its height in the rail, the mark alone, so nothing below it jumps
          on toggle. */}
      <div
        className={cn('flex h-8 w-full shrink-0 items-center', rail ? 'justify-center' : 'pl-2')}
      >
        <Logo mark={rail} className={rail ? 'h-4' : 'h-5'} />
      </div>
      <RailTip rail={rail} label={<Hint keys={paletteKey}>Search</Hint>}>
        <button
          type="button"
          aria-label="Search"
          onClick={onSearch}
          className={cn(
            'mt-2 mb-3.5 flex h-8 w-full shrink-0 items-center gap-2 rounded-md border border-line-strong bg-raised text-ink-3 hover:text-ink-2',
            rail ? 'justify-center' : 'pr-1.5 pl-2',
          )}
        >
          <Search />
          {!rail && 'Search'}
          {!rail && (
            <kbd className="ml-auto rounded-sm border border-line-strong px-1.5 text-[11px] leading-4 font-medium text-ink-2 max-md:hidden">
              {paletteKey}
            </kbd>
          )}
        </button>
      </RailTip>
      <nav aria-label="Main" className="w-full">
        <ul className="grid gap-px">
          {mainSections.map((section) => (
            <React.Fragment key={section.path}>
              {section.group &&
                (rail ? (
                  <li aria-hidden="true" className="mx-2 my-2 border-t border-line" />
                ) : (
                  <li className="px-2 pt-4.5 pb-1.5 text-small font-medium text-ink-3">
                    {section.group}
                  </li>
                ))}
              <NavItem section={section} rail={rail} count={countOf(section.path, data)} />
            </React.Fragment>
          ))}
        </ul>
        {!rail && data.agents.length > 0 && (
          <>
            <p className="px-2 pt-4.5 pb-1.5 text-small font-medium text-ink-3">Your agents</p>
            <ul className="grid gap-px">
              {data.agents.slice(0, agentsShown).map((agent) => (
                <li key={agent.id}>
                  <NavLink
                    to={agent.to ?? `/agents/${agent.id}`}
                    className="flex h-7.5 items-center gap-2.5 rounded-md px-2 text-ink-2 hover:bg-hover hover:text-ink aria-[current=page]:font-medium aria-[current=page]:text-ink max-md:h-10"
                  >
                    {agent.status ? (
                      <StatusMarker status={agent.status} className="mx-px" />
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <span className="truncate">{agent.name}</span>
                    {agent.status && <span className="sr-only">, {statusLabel[agent.status]}</span>}
                  </NavLink>
                </li>
              ))}
              {data.agents.length > agentsShown && (
                <li>
                  <NavLink
                    to="/agents"
                    end
                    className="flex h-7.5 items-center rounded-md pl-8.5 text-ink-2 hover:bg-hover hover:text-ink max-md:h-10"
                  >
                    All agents
                  </NavLink>
                </li>
              )}
            </ul>
          </>
        )}
      </nav>
      <ul className="mt-auto grid w-full gap-px pt-4">
        {footerSections.map((section) => (
          <NavItem key={section.path} section={section} rail={rail} />
        ))}
      </ul>
      <UserMenu
        name={data.user?.name ?? 'Account'}
        email={data.user?.email}
        rail={rail}
        onSignOut={onSignOut}
        onAccountSaved={onAccountSaved}
      />
    </>
  );
}

/** A tooltip label with its keyboard shortcut. */
const Hint = ({ keys, children }: { keys: string; children: React.ReactNode }) => (
  <>
    {children}
    <kbd className="ml-2 opacity-70">{keys}</kbd>
  </>
);

/** In the icon rail a control has no visible words, so its name shows on hover and focus. */
function RailTip({
  rail,
  label,
  children,
}: {
  rail: boolean;
  label: React.ReactNode;
  children: React.ReactElement;
}) {
  return rail ? <Tooltip label={label}>{children}</Tooltip> : children;
}

/**
 * A section's count: approvals wait on the person, in the waiting colour, nudging when they
 * grow; tasks in work wait on their agents, so theirs is quiet and has no dot in the rail.
 */
function countOf(path: string, data: ShellData): Count | undefined {
  if (path === '/approvals') return { value: data.approvalsWaiting, word: 'waiting', urgent: true };
  if (path === '/tasks') return { value: data.tasksInWork, word: 'in work', urgent: false };
  return undefined;
}

type Count = { value: number; word: string; urgent: boolean };

function NavItem(props: { section: Section; rail: boolean; count?: Count }) {
  const { section, rail } = props;
  const count = props.count?.value ?? 0;
  const urgent = props.count?.urgent ?? false;
  const word = props.count?.word ?? '';
  const label = count > 0 ? `${section.label}, ${count} ${word}` : section.label;
  // A count that grew since the last render nudges once; one that fell or stayed is still.
  const seen = React.useRef(count);
  const grew = count > seen.current;
  React.useEffect(() => {
    seen.current = count;
  }, [count]);
  return (
    <li>
      <RailTip rail={rail} label={label}>
        <NavLink
          to={section.path}
          end={section.path === '/'}
          aria-label={rail ? label : undefined}
          className={cn(
            'relative flex h-7.5 items-center gap-2.5 rounded-md font-medium text-ink-2 hover:bg-hover hover:text-ink aria-[current=page]:bg-selected aria-[current=page]:text-ink max-md:h-10',
            rail ? 'justify-center' : 'px-2',
          )}
        >
          <section.icon aria-hidden="true" className="shrink-0" />
          {!rail && section.label}
          {/* In the rail the count has no room; the waiting colour stays, as a dot. */}
          {rail && urgent && count > 0 && (
            <span
              key={count}
              aria-hidden="true"
              className={cn(
                'absolute top-1 right-1.5 size-1.5 rounded-full bg-waiting',
                grew && 'animate-nudge',
              )}
            />
          )}
          {!rail && count > 0 && (
            <span
              key={count}
              className={cn(
                'ml-auto text-small',
                urgent ? 'font-semibold text-waiting' : 'font-medium text-ink-3',
                urgent && grew && 'inline-block animate-nudge',
              )}
            >
              {count}
              <span className="sr-only"> {word}</span>
            </span>
          )}
        </NavLink>
      </RailTip>
    </li>
  );
}

function UserMenu({
  name,
  email,
  rail,
  onSignOut,
  onAccountSaved,
}: {
  name: string;
  email?: string;
  rail: boolean;
  onSignOut?: () => void;
  onAccountSaved?: () => void;
}) {
  const [theme, setTheme] = useTheme();
  const navigate = useNavigate();
  return (
    <>
      <M.DropdownMenu>
        <M.DropdownMenuTrigger
          aria-label={name}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-md hover:bg-hover',
            email ? 'h-10' : 'h-8 max-md:h-10',
            rail ? 'justify-center' : 'px-2',
          )}
        >
          {/* Always the glyph: the name then starts where the pages' and the seat's names do. */}
          <CircleUserRound aria-hidden="true" className="shrink-0 text-ink-2" />
          {/* The email under the name: it is a person, not a page (a name can be "Admin"). */}
          {!rail && (
            <span className="grid min-w-0 text-left">
              <span className="truncate">{name}</span>
              {email && <span className="truncate text-small text-ink-3">{email}</span>}
            </span>
          )}
          {!rail && <ChevronDown className="ml-auto shrink-0 text-ink-3" />}
        </M.DropdownMenuTrigger>
        <M.DropdownMenuContent side="top" align="start" className="w-52">
          <M.DropdownMenuLabel>Theme</M.DropdownMenuLabel>
          <M.DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => setTheme(value as Theme)}
          >
            <M.DropdownMenuRadioItem value="light">Light</M.DropdownMenuRadioItem>
            <M.DropdownMenuRadioItem value="dark">Dark</M.DropdownMenuRadioItem>
            <M.DropdownMenuRadioItem value="system">System</M.DropdownMenuRadioItem>
          </M.DropdownMenuRadioGroup>
          <M.DropdownMenuSeparator />
          {email && onAccountSaved && (
            <M.DropdownMenuItem onSelect={() => navigate('/settings/account')}>
              Account
            </M.DropdownMenuItem>
          )}
          <M.DropdownMenuItem onSelect={() => navigate('/settings/notifications')}>
            Notifications
          </M.DropdownMenuItem>
          <M.DropdownMenuItem onSelect={() => navigate('/settings/api-tokens')}>
            API tokens
          </M.DropdownMenuItem>
          {onSignOut && (
            <>
              <M.DropdownMenuSeparator />
              <M.DropdownMenuItem onSelect={onSignOut}>Sign out</M.DropdownMenuItem>
            </>
          )}
        </M.DropdownMenuContent>
      </M.DropdownMenu>
    </>
  );
}

function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  return (
    <C.CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Go to a page"
      description="Type a page name, then press Enter to open it."
    >
      <C.CommandInput placeholder="Search or jump to…" />
      <C.CommandList>
        <C.CommandEmpty>No matching pages.</C.CommandEmpty>
        <C.CommandGroup heading="Go to">
          {[...mainSections, ...footerSections].map((section) => (
            <C.CommandItem
              key={section.path}
              onSelect={() => {
                navigate(section.path);
                onOpenChange(false);
              }}
            >
              <section.icon />
              {section.label}
            </C.CommandItem>
          ))}
        </C.CommandGroup>
      </C.CommandList>
    </C.CommandDialog>
  );
}
