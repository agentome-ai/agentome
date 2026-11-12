import { Bell, ChevronRight, KeyRound, Search, SunMoon } from 'lucide-react';
import * as React from 'react';
import { Link, useOutletContext } from 'react-router';
import { useTheme, type Theme } from '../theme';
import { cn } from '../ui/cn';
import { Logo } from '../ui/logo';
import { statusLabel, StatusMarker } from '../ui/status';
import type { ShellData } from './app-shell';
import { footerSections, mainSections, type Section } from './sections';

/** What the shell hands the More screen: its data and the person's own actions. */
export type MoreContext = {
  data: ShellData;
  tabPaths: string[];
  onSearch: () => void;
  onSignOut?: () => void;
  onAccountSaved?: () => void;
};

// A line of a grouped list: a hairline over each but the first, from where the words start.
const row =
  'relative flex min-h-12 w-full items-center gap-3 px-3.5 text-left text-read active:bg-hover not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-11.5 not-first:before:border-t not-first:before:border-line';
const group = 'overflow-hidden rounded-xl bg-raised';
const caption = 'mx-3.5 mb-1.5 text-small text-ink-3';

const Chevron = () => <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-3" />;

/**
 * /more on a phone: the rest of the app as an app's own More tab, not the sidebar
 * in a sheet. The logo, large and with no title under it, says where one is; the person, the pages the tab bar has no room for,
 * their agents at work, and their settings in grouped lists, the theme switched in place.
 */
export function MorePage() {
  const { data, tabPaths, onSearch, onSignOut } = useOutletContext<MoreContext>();
  const [theme, setTheme] = useTheme();
  const user = data.user;
  const pages = mainSections.filter((section) => !tabPaths.includes(section.path));
  return (
    <div className="mx-auto grid max-w-150 gap-5.5 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-8">
      <div className="grid gap-4 pt-2">
        <Logo className="h-8.5 justify-self-start" />
        {/* The lit tab names the screen; the heading stays for a screen reader. */}
        <h1 className="sr-only">More</h1>
        <button
          type="button"
          onClick={onSearch}
          className="flex h-9.5 items-center gap-2 rounded-lg bg-selected px-3 text-read text-ink-3"
        >
          <Search aria-hidden="true" className="size-4" />
          Search
        </button>
      </div>

      {user && (
        <Link
          to="/settings/account"
          aria-label={`Account: ${user.name}`}
          className={cn(group, 'flex items-center gap-3 px-3.5 py-3 text-left active:bg-hover')}
        >
          <span
            aria-hidden="true"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-current/15 font-semibold text-tint-1"
          >
            {user.name.trim().charAt(0).toUpperCase()}
          </span>
          <span className="grid min-w-0 flex-1">
            <span className="truncate font-medium">{user.name}</span>
            {user.email && <span className="truncate text-small text-ink-3">{user.email}</span>}
          </span>
          <Chevron />
        </Link>
      )}

      <section>
        <h2 className={caption}>Workforce</h2>
        <ul className={group}>
          {pages.map((section) => (
            <PageRow key={section.path} section={section} />
          ))}
        </ul>
      </section>

      {data.agents.length > 0 && (
        <section>
          <h2 className={caption}>Your agents</h2>
          <ul className={group}>
            {data.agents.map((agent) => (
              <li key={agent.id} className={row}>
                <Link
                  to={agent.to ?? `/agents/${agent.id}`}
                  className="flex min-h-12 min-w-0 flex-1 items-center gap-3"
                >
                  {agent.status ? (
                    <StatusMarker status={agent.status} className="size-4.5" />
                  ) : (
                    <span className="size-4.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  {agent.status && (
                    <span className="shrink-0 text-ui text-ink-3">{statusLabel[agent.status]}</span>
                  )}
                  <Chevron />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className={caption}>Settings</h2>
        <ul className={group}>
          <li className={row}>
            <SunMoon aria-hidden="true" className="size-4.5 shrink-0 text-ink-2" />
            <span id="more-theme" className="flex-1">
              Theme
            </span>
            <ThemeSwitch theme={theme} onChange={setTheme} />
          </li>
          <li className={row}>
            <Link to="/settings/notifications" className="flex min-h-12 flex-1 items-center gap-3">
              <Bell aria-hidden="true" className="size-4.5 shrink-0 text-ink-2" />
              <span className="flex-1">Notifications</span>
              <Chevron />
            </Link>
          </li>
          <li className={row}>
            <Link to="/settings/api-tokens" className="flex min-h-12 flex-1 items-center gap-3">
              <KeyRound aria-hidden="true" className="size-4.5 shrink-0 text-ink-2" />
              <span className="flex-1">API tokens</span>
              <Chevron />
            </Link>
          </li>
          {footerSections.map((section) => (
            <PageRow key={section.path} section={section} />
          ))}
        </ul>
      </section>

      {onSignOut && (
        <button
          type="button"
          onClick={onSignOut}
          className={cn(group, 'min-h-12 font-medium text-failed active:bg-hover')}
        >
          Sign out
        </button>
      )}
    </div>
  );
}

function PageRow({ section }: { section: Section }) {
  return (
    <li className={row}>
      <Link to={section.path} className="flex min-h-12 flex-1 items-center gap-3">
        <section.icon aria-hidden="true" className="size-4.5 shrink-0 text-ink-2" />
        <span className="flex-1">{section.label}</span>
        <Chevron />
      </Link>
    </li>
  );
}

const themes: [Theme, string][] = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['system', 'Auto'],
];

/** The theme as a phone's segmented control: three choices, the one in use raised. */
function ThemeSwitch({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <span
      role="radiogroup"
      aria-labelledby="more-theme"
      className="grid grid-cols-3 rounded-lg bg-selected p-0.5 text-ui"
    >
      {themes.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => onChange(value)}
          className="rounded-md px-2.5 py-1 text-ink-2 aria-checked:bg-raised aria-checked:text-ink aria-checked:shadow-sm"
        >
          {label}
        </button>
      ))}
    </span>
  );
}
