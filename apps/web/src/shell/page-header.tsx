import { ChevronLeft } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { cn } from '../ui/cn';
import { Logo } from '../ui/logo';
import { tabPaths } from './sections';

/** Horizontal page padding: 16 px on tablets, 24 px from 1024, 32 px from 1440. */
export const gutter = 'px-4 lg:px-6 2xl:px-8';

// A page laid out as a grid gets one column that may shrink: with the default `auto` track a
// row that cannot wrap widens the whole page past a phone's screen.
const column = 'grid-cols-[minmax(0,1fr)]';

/**
 * The column a page lives in, centered once the screen is wider than it, with its header's
 * title and actions on the same edges as its content: tables, a run and the editor get 1440 px,
 * a page read as a document (a task, approvals, a project, admin) 992 px. Below that the column
 * is the screen, as before; on a 2560 px screen nothing is pinned left with half of it empty.
 */
export const frame = {
  // 1440, and 1680 from a 1680 px screen: past ~1930 px the narrower column left a third of the
  // screen empty beside the tables. Documents keep their measure.
  wide: cn('mx-auto w-full max-w-360 3xl:max-w-420', column, gutter),
  read: cn('mx-auto w-full max-w-248', column, gutter),
  // A run: its 820 px of reading, 340 of results and the gap between, so that on a wide screen
  // the two stand in the middle under their header rather than against the left of 1680 px.
  pair: cn('mx-auto w-full max-w-318', column, gutter),
} as const;
export type PageWidth = keyof typeof frame;

/**
 * A page of a list and the item picked from it (Approvals, the Library), in the wide frame as
 * every page is: the list stands under the page's title and the item beside the list. Before,
 * the list was pinned to the sidebar and the item centred in what was left: on
 * a wide screen it drifted half a screen from the list, and the title stood on a third line.
 * The list's rows keep their own 16 px, so the list steps that far into the gutter and its text
 * meets the title's edge. A phone has no gutter here: its rows are the screen's width.
 */
export const split = {
  page: 'mx-auto grid w-full max-w-360 grid-cols-[minmax(0,1fr)] md:h-[calc(100dvh-53px)] md:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] md:px-4 lg:px-6 2xl:px-8 3xl:max-w-420',
  list: 'min-w-0 md:-ml-4 md:overflow-y-auto md:border-r md:border-line',
  item: 'min-w-0 md:overflow-y-auto',
  /**
   * The item and its context. From 1800 px the context is a column of its own beside the
   * item's, as a tracker sets an issue's properties beside the issue: narrower than that the two
   * do not fit with a reading measure, and the context stands in the item's column.
   */
  body: 'grid grid-cols-[minmax(0,1fr)] content-start gap-x-12 gap-y-5 px-4 pt-4 pb-24 md:px-10 md:pt-8 min-[1800px]:grid-cols-[minmax(0,760px)_minmax(0,320px)]',
  column: 'grid min-w-0 max-w-190 grid-cols-[minmax(0,1fr)] content-start gap-5',
  context:
    'grid min-w-0 max-w-190 grid-cols-[minmax(0,1fr)] content-start gap-6 min-[1800px]:col-start-2 min-[1800px]:row-start-1 min-[1800px]:row-span-2',
  /** What shows only while the context has no column of its own, and only once it has. */
  narrow: 'min-[1800px]:hidden',
  wide: 'max-[1799px]:hidden',
} as const;

/**
 * The facts of a picked item, in its context column: shown once that column stands beside the
 * item, where the item's own header says them while it does not.
 */
export function ContextFacts(props: { facts: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className={cn('grid gap-2.5', split.wide)}>
      {props.facts.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-3">
          <dt className="text-ink-3">{label}</dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type Crumb = { label: string; to: string };

const titleClass =
  'min-w-0 truncate font-medium md:text-ui max-md:text-center max-md:text-read max-md:font-semibold';

/**
 * The top of a page: a quiet sticky bar with the path to the page and its actions. A page under
 * another (a task, a run, a team) then has its title in the body, where it reads as the page's
 * heading and scrolls away with it, and the bar's last step is the page itself. A top page (Teams,
 * Runs) is named once, in the bar: a heading under it would only repeat it. A page
 * whose own content names it (the agent editor, under its sheet) keeps the title in the bar too.
 */
export function PageHeader({
  title,
  crumbs = [],
  actions,
  width = 'wide',
  titleIn = 'body',
  big = false,
  ownHeading,
  phoneBack,
}: {
  title: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
  width?: PageWidth;
  titleIn?: 'body' | 'bar';
  /** A document's title, as large as a name: a task's, read like Linear's issue. */
  big?: boolean;
  /** The body's heading in place of the title: a task's, changed where it is read. */
  ownHeading?: ReactNode;
  /** A phone's way back from a top page that is not a tab's: settings go back to More. */
  phoneBack?: Crumb;
}) {
  const inBar = titleIn === 'bar';
  const top = !inBar && crumbs.length === 0;
  // On a phone a top page's bar carries the logo, and a tab's page has no title at all:
  // its lit tab names it. A top page off the tab bar (Teams, Admin) keeps its title under the logo.
  const { pathname } = useLocation();
  const tab = top && tabPaths.includes(pathname);
  // On a phone the bar is an app's: back to the page above on the left, the page's name in
  // the middle once its large title has scrolled away, the actions on the right.
  const heading = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const element = heading.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry?.isIntersecting), {
      rootMargin: '-56px 0px 0px 0px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const back = phoneBack ?? crumbs.at(-1);
  const named = inBar || scrolled;
  return (
    <>
      <header
        className={cn(
          // Over the page as it scrolls, a little see-through, as Vercel's bar is. On a phone its
          // rule shows once the page has scrolled under it.
          'sticky top-0 z-10 border-b border-line bg-paper/85 backdrop-blur-md',
          !named && 'max-md:border-transparent max-md:bg-paper',
        )}
      >
        <div
          className={cn(
            'flex h-13 items-center gap-2 max-md:grid max-md:h-11 max-md:grid-cols-[auto_minmax(0,1fr)_auto]',
            frame[width],
          )}
        >
          <div className="min-w-0 md:hidden">
            {top && !phoneBack && <Logo className="h-6.5" />}
            {back && (
              <Link
                to={back.to}
                className="-ml-1.5 inline-flex h-11 max-w-[30vw] items-center gap-0.5 text-read text-ink-2 active:opacity-60"
              >
                <ChevronLeft aria-hidden="true" className="size-5 shrink-0" />
                <span className="truncate">{back.label}</span>
              </Link>
            )}
          </div>
          {crumbs.length > 0 && (
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-2 text-ui max-md:hidden"
            >
              {crumbs.map((crumb) => (
                <Fragment key={crumb.to}>
                  <Link to={crumb.to} className="truncate text-ink-2 hover:text-ink">
                    {crumb.label}
                  </Link>
                  <span aria-hidden="true" className="text-ink-3">
                    /
                  </span>
                </Fragment>
              ))}
            </nav>
          )}
          {/* One title for both: after the path on a wide screen, in the middle of a phone's bar,
              where a page with its title in the body shows it only once that has scrolled away. */}
          {inBar ? (
            <h1 className={titleClass}>{title}</h1>
          ) : (
            <span
              aria-hidden={top || undefined}
              className={cn(
                titleClass,
                'transition-opacity duration-150',
                !named && 'max-md:opacity-0',
                tab && 'max-md:hidden',
              )}
            >
              {title}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center justify-end gap-1">{actions}</div>
        </div>
      </header>
      {!inBar && (
        // A top page keeps 8 px here, so its content starts 24 px under the bar.
        <div ref={heading} className={cn(frame[width], 'pt-8 max-md:pt-3', top && 'md:pt-2')}>
          {ownHeading ?? (
            <h1
              className={cn(
                big ? 'text-name' : 'text-title',
                top && 'md:sr-only',
                tab && 'max-md:sr-only',
              )}
            >
              {title}
            </h1>
          )}
        </div>
      )}
    </>
  );
}
