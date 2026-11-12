import { Check, GitBranch, Laptop } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, asApiError } from '../api';
import { cn } from '../ui/cn';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { repositoryProblem } from './tasks-data';

// Where a task works: a folder on the computer that runs it, or a repository it clones. One
// choice, so one picker, wherever it is made.

export const isFolder = (where: string) => where.startsWith('/') || where.startsWith('~/');

/** "acme/payments" for a URL, the path as it is for a folder on the computer. */
export const whereLabel = (where: string) => where.replace(/^https?:\/\/[^/]+\//, '');

/** The icon and the name of where a task works, for a chip or a menu's line. */
export function Where(props: { where: string; className?: string }) {
  const Icon = props.where && isFolder(props.where) ? Laptop : GitBranch;
  return (
    <>
      <Icon aria-hidden="true" className={cn('text-ink-2', props.className)} />
      <span className={cn('truncate', !props.where && 'text-ink-3')}>
        {props.where ? whereLabel(props.where) : 'No repository'}
      </span>
    </>
  );
}

/**
 * The menu behind `trigger`: the folders of the person's earlier tasks, the repositories offered
 * (`main` first, the project's own, in place of no repository), and a path or URL typed into its
 * search. A choice `onChange` refuses keeps the menu open with its message.
 */
export function RepositoryPicker(props: {
  value: string;
  repositories: string[];
  main?: string;
  onChange: (value: string) => void | Promise<void>;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [refused, setRefused] = useState<string>();
  const where = props.value.trim();
  const typed = query.trim();
  const problem = refused ?? (typed ? repositoryProblem(typed) : undefined);
  const known = [...folders, ...props.repositories];
  const matches = (value: string) => value.toLowerCase().includes(typed.toLowerCase());
  const own = typed && !known.includes(typed) ? typed : undefined;
  const key = (value: string) =>
    value ? `${folders.includes(value) ? 'folder' : 'repository'}:${value}` : 'none';

  async function take(value: string) {
    try {
      await props.onChange(value);
      setOpen(false);
    } catch (caught) {
      setRefused(asApiError(caught).message);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        setRefused(undefined);
        // Read each time: a folder typed for the last task is offered for this one.
        // A path or URL of one's own comes back to be edited; one offered is chosen again.
        const start = known.includes(where) ? '' : where;
        setQuery(start);
        setChosen(start ? `own:${start}` : key(where));
        api<{ folders: string[] }>('/api/tasks/folders').then(
          (answer) => {
            setFolders(answer.folders);
            // The folder turns out to be one offered: chosen in its group, not typed.
            if (!start || !answer.folders.includes(start)) return;
            setQuery((now) => (now === start ? '' : now));
            setChosen((now) => (now === `own:${start}` ? `folder:${start}` : now));
          },
          () => undefined,
        );
      }}
    >
      <PopoverTrigger asChild>{props.trigger}</PopoverTrigger>
      <PopoverContent
        aria-label="Where the task works"
        className="w-96 max-w-[calc(100vw-32px)] p-0"
      >
        <Command
          label="Folder path or repository URL"
          shouldFilter={false}
          value={chosen}
          onValueChange={setChosen}
        >
          <CommandInput
            placeholder="Folder path or repository URL"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              setRefused(undefined);
              const first = next.trim();
              const offered = known.find((value) =>
                value.toLowerCase().includes(first.toLowerCase()),
              );
              setChosen(first && !known.includes(first) ? `own:${first}` : key(offered ?? ''));
            }}
          />
          {problem && <p className="px-3.5 pt-2 text-small text-failed">{problem}</p>}
          <CommandList>
            {own && (
              <CommandItem
                value={`own:${own}`}
                disabled={!!problem}
                onSelect={() => void take(own)}
              >
                {isFolder(own) ? (
                  <Laptop aria-hidden="true" className="size-3.5" />
                ) : (
                  <GitBranch aria-hidden="true" className="size-3.5" />
                )}
                <span className="min-w-0 truncate">
                  Use <span className="font-mono">{own}</span>
                </span>
              </CommandItem>
            )}
            {(!typed || folders.some(matches)) && (
              <CommandGroup heading="On your computer">
                {folders.filter(matches).map((folder) => (
                  <Line
                    key={folder}
                    value={`folder:${folder}`}
                    where={folder}
                    current={folder === where}
                    onSelect={() => void take(folder)}
                  />
                ))}
                {!typed && (
                  <p className="px-2 py-1.5 text-small text-ink-3">
                    {folders.length > 0
                      ? 'Type a path to work in another folder.'
                      : 'Type a folder’s path, such as ~/code/app. Its commits come back to it as a branch.'}
                  </p>
                )}
              </CommandGroup>
            )}
            {props.repositories.some(matches) && (
              <CommandGroup heading="Repositories">
                {props.repositories.filter(matches).map((url) => (
                  <Line
                    key={url}
                    value={`repository:${url}`}
                    where={url}
                    current={url === where}
                    note={url === props.main ? 'Main' : undefined}
                    onSelect={() => void take(url)}
                  />
                ))}
              </CommandGroup>
            )}
            {!typed && !props.main && (
              <CommandItem value="none" onSelect={() => void take('')}>
                <span className="size-3.5" />
                No repository
                <span className="ml-auto text-small text-ink-3">A new empty folder each run</span>
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Line(props: {
  value: string;
  where: string;
  current: boolean;
  note?: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={props.value} onSelect={props.onSelect}>
      {isFolder(props.where) ? (
        <Laptop aria-hidden="true" className="size-3.5" />
      ) : (
        <GitBranch aria-hidden="true" className="size-3.5" />
      )}
      <span className="min-w-0 truncate font-mono" title={props.where}>
        {whereLabel(props.where)}
      </span>
      {props.note && <span className="ml-auto shrink-0 text-small text-ink-3">{props.note}</span>}
      <Check
        aria-hidden="true"
        className={cn('size-3.5', !props.note && 'ml-auto', !props.current && 'invisible')}
      />
    </CommandItem>
  );
}
