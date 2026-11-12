import type { ReactNode } from 'react';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { StatusMarker } from '../ui/status';

/**
 * What this place is and the first thing to do in it. The only centered block in a page. With a
 * `preview`, the shape of what will land here is drawn faint above it.
 */
export function EmptyState(props: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  preview?: 'rows' | 'approval';
}) {
  return (
    <div
      className={cn(
        'mx-auto flex max-w-110 flex-col items-center px-4 py-24 text-center',
        props.preview && 'pt-10',
      )}
    >
      {props.preview && <Ghost kind={props.preview} />}
      <h2 className="text-section">{props.title}</h2>
      <p className="mt-1 text-read text-ink-2">{props.children}</p>
      {props.action && <div className="mt-5">{props.action}</div>}
    </div>
  );
}

const ghostLine = 'block h-2 rounded-full bg-selected';

/** Two faint items of what the empty place will hold, fading out: rows, or an approval. */
function Ghost({ kind }: { kind: 'rows' | 'approval' }) {
  return (
    <div aria-hidden="true" className="mb-8 grid w-full max-w-90 gap-2.5 mask-b-from-30% text-left">
      {['78%', '56%'].map((width, index) => (
        <div
          key={width}
          className={cn(
            'rounded-xl border border-dashed border-line-strong p-3',
            index > 0 && 'opacity-60',
          )}
        >
          <div className="flex items-center gap-2.5">
            <span className="size-7 shrink-0 rounded-lg bg-selected" />
            <span className="grid flex-1 gap-2">
              <span className={ghostLine} style={{ width }} />
              <span className={cn(ghostLine, 'w-2/5 bg-hover')} />
            </span>
          </div>
          {kind === 'approval' && (
            <div className="mt-3 grid grid-cols-2 gap-2 text-small text-ink-3">
              <span className="grid h-7 place-items-center rounded-md border border-line-strong">
                Deny
              </span>
              <span className="grid h-7 place-items-center rounded-md bg-accent-subtle text-accent">
                Approve
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Fixed widths so the skeleton looks like the table that will replace it, without shimmer.
const skeletonRows = ['62%', '48%', '71%', '55%', '66%', '43%'];

/** A still skeleton with the geometry of a table: header, rows, numbers on the right. */
export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      <div className="flex h-8 items-center gap-6 border-b border-line">
        <span className="h-2 w-16 rounded-sm bg-selected" />
        <span className="h-2 w-24 rounded-sm bg-selected" />
        <span className="ml-auto h-2 w-12 rounded-sm bg-selected" />
      </div>
      {skeletonRows.map((width) => (
        <div key={width} className="flex h-9 items-center gap-6 border-b border-line">
          <span className="size-3.5 shrink-0 rounded-full bg-selected" />
          <span className="h-2 rounded-sm bg-hover" style={{ width }} />
          <span className="ml-auto h-2 w-10 rounded-sm bg-hover" />
        </div>
      ))}
    </div>
  );
}

/** Says what happened and what to do next. Does not apologize. */
export function ErrorState(props: { title: string; children: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 py-6">
      <StatusMarker status="failed" className="mt-[3px]" />
      <div>
        <p className="font-medium">{props.title}</p>
        <p className="text-ink-2">{props.children}</p>
        {props.onRetry && (
          <Button size="sm" className="mt-3" onClick={props.onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
