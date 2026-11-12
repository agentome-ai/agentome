import { frame, PageHeader } from '../shell/page-header';
import { cn } from '../ui/cn';

const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const mod = mac ? '⌘' : 'Ctrl';

// Every key the app answers to, where it works. A new shortcut gets its line here.
const groups: { title: string; keys: [string[], string][] }[] = [
  {
    title: 'Anywhere',
    keys: [
      [[mod, 'K'], 'Search and jump to a page'],
      [['['], 'Collapse or expand the sidebar'],
      [['Esc'], 'Close a dialog, a menu or search'],
    ],
  },
  {
    title: 'Search, menus and pickers',
    keys: [
      [['↑', '↓'], 'Move through the options'],
      [['Enter'], 'Open or pick the option'],
      [['A–Z'], 'Type to narrow a picker to what matches'],
    ],
  },
  {
    title: 'Agent editor',
    keys: [[[mod, 'S'], 'Save changes']],
  },
];

/** /help: the keyboard shortcuts, grouped by where they work. */
export function HelpPage() {
  return (
    <>
      <PageHeader title="Help" />
      <div className={cn(frame.wide, 'grid gap-8 pt-4 pb-24')}>
        <h2 className="text-section">Keyboard shortcuts</h2>
        <div className="grid max-w-248 gap-8 lg:grid-cols-2">
          {groups.map((group, index) => (
            <section key={group.title} aria-labelledby={`keys-${index}`} className="grid gap-2">
              <h3 id={`keys-${index}`} className="text-small font-medium text-ink-3">
                {group.title}
              </h3>
              <dl className="grid">
                {group.keys.map(([keys, action]) => (
                  <div
                    key={action}
                    className="flex h-10 items-center justify-between gap-4 border-b border-line"
                  >
                    <dt className="text-ink-2">{action}</dt>
                    <dd className="flex shrink-0 gap-1">
                      {keys.map((key) => (
                        <kbd
                          key={key}
                          className="min-w-6 rounded-sm font-sans border border-line-strong bg-raised px-1.5 text-center text-small leading-5 font-medium text-ink"
                        >
                          {key}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
