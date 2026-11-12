import {
  BadgeCheck,
  Boxes,
  Cable,
  ChevronRight,
  Laptop,
  Package,
  ScrollText,
  Users,
} from 'lucide-react';
import { Link } from 'react-router';
import { frame, PageHeader } from '../shell/page-header';
import { cn } from '../ui/cn';
import { buildLabel, HOW_TO_UPDATE, useVersion } from './version';

// Admin grows a page at a time (people, seats, connections, settings). Every page is
// listed: a page reached only through another one's column was not found.
const groups = [
  {
    title: 'Access',
    pages: [
      {
        to: '/admin/people',
        icon: Users,
        title: 'People',
        text: 'Who can sign in, their roles and invitation links',
      },
      {
        to: '/admin/computers',
        icon: Laptop,
        title: 'Computers',
        text: 'Where agents run, on their owner’s Claude subscription, and how to connect yours',
      },
      {
        to: '/admin/connections',
        icon: Cable,
        title: 'Connections',
        text: 'Code hosts the projects reach, and the account agents act as',
      },
      {
        to: '/admin/models',
        icon: Boxes,
        title: 'Models',
        text: 'Anthropic, OpenAI or a gateway such as LiteLLM, for agents that work on the server',
      },
    ],
  },
  {
    title: 'Installation',
    pages: [
      {
        to: '/admin/license',
        icon: BadgeCheck,
        title: 'License',
        text: 'Whom Agentome is licensed to, until when, and a new key',
      },
    ],
  },
  {
    title: 'Troubleshooting',
    pages: [
      {
        to: '/admin/logs',
        icon: ScrollText,
        title: 'Logs',
        text: 'A month of the server’s and the computers’ log lines, and what each request did',
      },
    ],
  },
];

/**
 * Admin's pages in grouped lists, as the settings of More on a phone: a panel with a
 * hairline between its rows on a desk, the phone's raised groups on a phone.
 */
export function AdminPage() {
  const { build, newer, checked } = useVersion();
  const link = 'font-medium text-ink underline underline-offset-2';
  return (
    <>
      <PageHeader title="Admin" />
      <div className={cn('grid gap-8 pt-8 pb-24 max-md:gap-5.5 max-md:pt-4', frame.read)}>
        {newer && build?.version && (
          <p
            role="status"
            className="rounded-lg border border-line-strong px-4 py-3 text-ink-2 max-md:mx-3.5"
          >
            <span className="font-medium text-ink">Agentome {newer.version} is out.</span> You run{' '}
            {build.version}.{' '}
            <a href={newer.url} target="_blank" rel="noreferrer" className={link}>
              What’s new
            </a>
            ,{' '}
            <a href={HOW_TO_UPDATE} target="_blank" rel="noreferrer" className={link}>
              how to update
            </a>
            .
          </p>
        )}
        {groups.map((group) => (
          <section key={group.title} aria-labelledby={`admin-${group.title}`}>
            <h2
              id={`admin-${group.title}`}
              className="mb-2 text-small text-ink-3 max-md:mx-3.5 max-md:mb-1.5"
            >
              {group.title}
            </h2>
            <ul className="overflow-hidden rounded-lg border border-line max-md:rounded-xl max-md:border-0 max-md:bg-raised">
              {group.pages.map((page) => (
                <li
                  key={page.to}
                  className="relative not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-12 not-first:before:border-t not-first:before:border-line max-md:not-first:before:left-11.5"
                >
                  <Link
                    to={page.to}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-hover max-md:gap-3 max-md:px-3.5 max-md:py-2.5 max-md:hover:bg-transparent max-md:active:bg-hover"
                  >
                    <page.icon aria-hidden="true" className="size-4.5 shrink-0 text-ink-2" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium max-md:text-read">{page.title}</span>
                      <span className="block text-ink-2 max-md:text-small max-md:text-ink-3">
                        {page.text}
                      </span>
                    </span>
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                  </Link>
                </li>
              ))}
              {/* The installation's version, always: what an admin names when asking for help. */}
              {group.title === 'Installation' && build && (
                <li className="relative flex items-center gap-4 px-4 py-3 before:absolute before:top-0 before:right-0 before:left-12 before:border-t before:border-line max-md:gap-3 max-md:px-3.5 max-md:py-2.5 max-md:before:left-11.5">
                  <Package aria-hidden="true" className="size-4.5 shrink-0 text-ink-2" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium max-md:text-read">Version</span>
                    <span className="block text-ink-2 max-md:text-small max-md:text-ink-3">
                      {buildLabel(build)}
                    </span>
                  </span>
                  {newer ? (
                    <a
                      href={newer.url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-small font-medium text-ink underline underline-offset-2"
                    >
                      {newer.version} is out
                    </a>
                  ) : (
                    checked && <span className="shrink-0 text-small text-ink-3">Up to date</span>
                  )}
                </li>
              )}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
