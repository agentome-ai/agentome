import { Ellipsis } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { cn } from './cn';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu';

/**
 * A line of a list, as Linear's: what it is, its name, a quiet detail, a tag, and its actions
 * behind "…", which shows on hover or focus on a wide screen and always on a phone.
 */
export function Row(props: {
  lead: ReactNode;
  name: ReactNode;
  detail?: ReactNode;
  tag?: string;
  menu?: ReactNode;
  /** What the "…" acts on, for its name: "Actions for Developer". */
  what: string;
}) {
  return (
    <li className="group -mx-2 grid min-h-11 grid-cols-[20px_minmax(0,14rem)_minmax(0,1fr)_auto_28px] items-center gap-x-2.5 border-b border-line px-2 py-1.5 hover:bg-hover max-md:grid-cols-[20px_minmax(0,1fr)_auto_28px] max-md:gap-y-0.5">
      {props.lead}
      {/* Without a detail the name takes its column too: a repository's URL is long. */}
      <span className={cn('flex min-w-0', props.detail === undefined && 'md:col-span-2')}>
        {props.name}
      </span>
      {props.detail !== undefined && (
        <span className="min-w-0 truncate text-ink-3 max-md:col-start-2 max-md:col-end-[-1] max-md:row-start-2 max-md:text-small">
          {props.detail}
        </span>
      )}
      <span className="max-md:col-start-3 max-md:row-start-1">
        {props.tag && (
          <span className="inline-flex h-5 items-center rounded-sm border border-line-strong px-1.5 text-small text-ink-2">
            {props.tag}
          </span>
        )}
      </span>
      <span className="max-md:col-start-4 max-md:row-start-1">
        {props.menu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label={`Actions for ${props.what}`}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
              >
                <Ellipsis aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{props.menu}</DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
    </li>
  );
}
