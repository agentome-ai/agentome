// Which code host or Jira something lives on, as two letters: it rides next to a name in a chip,
// a table cell or the agent sheet, where the word would be longer than what it qualifies.

export type Host = 'gitlab' | 'github' | 'jira';
export const hostName: Record<Host, string> = { gitlab: 'GitLab', github: 'GitHub', jira: 'Jira' };
const letters: Record<Host, string> = { gitlab: 'GL', github: 'GH', jira: 'JI' };

export function HostGlyph({ host, className }: { host: Host; className?: string }) {
  return (
    <span title={hostName[host]} className={className}>
      <span
        aria-hidden="true"
        className="inline-grid h-4 min-w-5 place-items-center rounded-[3px] bg-desk px-[3px] align-[1px] text-[9.5px] leading-none font-semibold text-ink-2"
      >
        {letters[host]}
      </span>
      <span className="sr-only">{hostName[host]}</span>
    </span>
  );
}

// Each system's mark, where the choice of system is the subject: New connection's tabs. GitHub's
// is the ink colour, as GitHub draws it on either ground; the others keep their own.
const logos: Record<Host, { viewBox: string; path: string; color: string }> = {
  github: {
    viewBox: '0 0 16 16',
    color: 'currentColor',
    path: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z',
  },
  gitlab: {
    viewBox: '0 0 24 24',
    color: '#fc6d26',
    path: 'm23.6 9.593-.033-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44L16.47 7.818H7.537L5.333 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.859.859 0 0 0-.336.405L.433 9.502l-.032.086a6.066 6.066 0 0 0 2.012 7.01l.01.009.03.021 4.977 3.727 2.462 1.863 1.5 1.132a1.008 1.008 0 0 0 1.22 0l1.499-1.132 2.461-1.863 5.006-3.75.012-.01a6.068 6.068 0 0 0 2.01-7.002z',
  },
  jira: {
    viewBox: '0 0 24 24',
    color: '#2684ff',
    path: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0z',
  },
};

export function HostLogo({ host, className }: { host: Host; className?: string }) {
  const { viewBox, path, color } = logos[host];
  return (
    <svg viewBox={viewBox} aria-hidden="true" className={className} fill={color}>
      <path d={path} />
    </svg>
  );
}
