import { type ReactNode, useId } from 'react';
import { cn } from './cn';

/** A part of a page: its heading, an action beside it, and what it says when empty. */
export function Section(props: {
  title: string;
  /** How many it holds, beside its name: the heading is then ruled off, as Linear's lists are. */
  count?: number;
  /** One line under the heading on what the section holds, when its name alone does not say. */
  note?: string;
  action?: ReactNode;
  empty: string;
  isEmpty: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <div
        className={cn(
          'flex min-h-7 items-center gap-4',
          props.count !== undefined && 'gap-2 border-b border-line pb-2',
        )}
      >
        <h2 id={id} className="text-section">
          {props.title}
        </h2>
        {props.count !== undefined && <span className="text-ink-3">{props.count}</span>}
        <div className="ml-auto">{props.action}</div>
      </div>
      {props.note && !props.isEmpty && (
        <p className="-mt-1 max-w-150 text-small text-ink-3">{props.note}</p>
      )}
      {props.isEmpty ? (
        <p className="max-w-150 text-read text-ink-2">{props.empty}</p>
      ) : (
        props.children
      )}
    </section>
  );
}
