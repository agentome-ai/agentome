import type { ReactNode } from 'react';

// The phone's tab bar draws its own icons: one shape twice, a 2 px outline and, for the
// open tab, filled with its cut-outs in the page's colour, so the open tab reads at a glance now
// that the tab pages carry no title.
type Glyph = { outline: ReactNode; filled: ReactNode };

const cut = 'var(--bg)';

const glyphs: Record<string, Glyph> = {
  '/': {
    outline: (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
      </>
    ),
    filled: (
      <g fill="currentColor">
        <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
      </g>
    ),
  },
  '/approvals': {
    outline: (
      <>
        <path d="M3 13l2.6-7.2A2 2 0 0 1 7.5 4.5h9a2 2 0 0 1 1.9 1.3L21 13v4.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M3 13h5l1.5 2.5h5L16 13h5" />
      </>
    ),
    filled: (
      <>
        <path
          fill="currentColor"
          d="M3 13l2.6-7.2A2 2 0 0 1 7.5 4.5h9a2 2 0 0 1 1.9 1.3L21 13v4.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        />
        <path stroke={cut} d="M3.5 13h4.5l1.5 2.5h5L16 13h4.5" />
      </>
    ),
  },
  '/tasks': {
    outline: (
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
        <path d="M8.5 12.2l2.4 2.4 4.8-5" />
      </>
    ),
    filled: (
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="currentColor" />
        <path stroke={cut} d="M8.5 12.2l2.4 2.4 4.8-5" />
      </>
    ),
  },
  '/runs': {
    outline: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M10.2 8.8v6.4l5-3.2z" />
      </>
    ),
    filled: (
      <>
        <circle cx="12" cy="12" r="8.5" fill="currentColor" />
        <path d="M10.2 8.8v6.4l5-3.2z" fill={cut} stroke={cut} />
      </>
    ),
  },
  '/more': {
    outline: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <g fill="currentColor">
          <circle cx="8.2" cy="12" r=".6" />
          <circle cx="12" cy="12" r=".6" />
          <circle cx="15.8" cy="12" r=".6" />
        </g>
      </>
    ),
    filled: (
      <>
        <circle cx="12" cy="12" r="8.5" fill="currentColor" />
        <g fill={cut} stroke={cut}>
          <circle cx="8.2" cy="12" r=".6" />
          <circle cx="12" cy="12" r=".6" />
          <circle cx="15.8" cy="12" r=".6" />
        </g>
      </>
    ),
  },
};

/** A tab's icon on its pill: lit and filled when the tab is open. */
export function TabIcon({ path, open, dot }: { path: string; open: boolean; dot?: boolean }) {
  const glyph = glyphs[path];
  return (
    <span
      className={
        open
          ? 'relative grid h-7.5 w-14 place-items-center rounded-full bg-selected'
          : 'relative grid h-7.5 w-14 place-items-center rounded-full'
      }
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-6"
      >
        {glyph && (open ? glyph.filled : glyph.outline)}
      </svg>
      {/* The rail's dot: an approval waits. */}
      {dot && (
        <span
          aria-hidden="true"
          className="absolute top-0.5 right-3 size-2 rounded-full border-2 border-paper bg-waiting box-content"
        />
      )}
    </span>
  );
}
