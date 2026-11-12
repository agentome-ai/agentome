import * as Icon from 'lucide-react';
import { PageHeader } from './page-header';
import { EmptyState } from './states';

export type Section = {
  path: string;
  label: string;
  icon: Icon.LucideIcon;
  /** The heading of the group this section opens in the sidebar: work above, the people below. */
  group?: string;
  empty: { title: string; text: string };
};

// Below 768 px the sidebar is a tab bar at the thumb: the pages a push opens and the ones used
// on the go. More opens the rest as a screen of its own (/more), as an app's More tab does.
export const tabPaths = ['/', '/approvals', '/tasks', '/runs'];

export const paletteKey = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';

// One list feeds the sidebar, the palette and the routes, so a page has one name everywhere.
// The work comes first, then who does it.
// An empty page says, in one sentence, what it is for and the first thing to do.
export const mainSections: Section[] = [
  {
    path: '/',
    label: 'Dashboard',
    icon: Icon.Activity,
    empty: {
      title: 'No runs yet',
      text: 'Run a task to see who is working on what, what finished today and what it cost.',
    },
  },
  {
    path: '/approvals',
    label: 'Approvals',
    icon: Icon.Inbox,
    empty: {
      title: 'Nothing is waiting for you',
      text: 'When an agent needs your approval for a step, the request waits here until you approve or deny it.',
    },
  },
  {
    path: '/tasks',
    label: 'Tasks',
    icon: Icon.ListChecks,
    empty: {
      title: 'No tasks yet',
      text: 'Create a task for an agent, then run it on a connected computer.',
    },
  },
  {
    path: '/runs',
    label: 'Runs',
    icon: Icon.ScrollText,
    empty: {
      title: 'No runs yet',
      text: 'Run a task from an agent page, and its transcript, artifacts and cost show up here.',
    },
  },
  {
    path: '/agents',
    label: 'Agents',
    icon: Icon.IdCard,
    group: 'Workforce',
    empty: {
      title: 'No agents yet',
      text: 'Create an agent from a role template, then give it instructions, tools and a budget.',
    },
  },
  {
    path: '/teams',
    label: 'Teams',
    icon: Icon.UsersRound,
    empty: {
      title: 'No teams yet',
      text: 'Create a team, give it a lead and add agents to it: the lead splits its tasks between them.',
    },
  },
  {
    path: '/projects',
    label: 'Projects',
    icon: Icon.Folder,
    empty: {
      title: 'No projects yet',
      text: 'A project gives its agents the repositories of a code host. An admin creates one.',
    },
  },
  {
    path: '/library',
    label: 'Library',
    icon: Icon.Library,
    empty: {
      title: 'The library is empty',
      text: 'Add skills, MCP servers and role templates here to share them with every agent.',
    },
  },
];

export const footerSections: Section[] = [
  {
    path: '/admin',
    label: 'Admin',
    icon: Icon.SlidersHorizontal,
    empty: {
      title: 'Nothing set up yet',
      text: 'Invite people, connect computers and add code hosts for the whole company here.',
    },
  },
  {
    path: '/help',
    label: 'Help',
    icon: Icon.CircleQuestionMark,
    empty: {
      title: 'Keyboard shortcuts',
      text: `Press ${paletteKey} anywhere to jump to a page, or [ to collapse the sidebar.`,
    },
  },
];

export function SectionPage({ section }: { section: Section }) {
  return (
    <>
      <PageHeader title={section.label} />
      <EmptyState title={section.empty.title}>{section.empty.text}</EmptyState>
    </>
  );
}
