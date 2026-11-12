import { cn } from '../ui/cn';
import type { Progress } from './plans';

/**
 * How far a run is through its plan: a segment a step, the done ones filled, then the step in
 * progress in words. Nothing for a run that keeps no plan.
 */
export function PlanLine({ progress }: { progress: Progress | null | undefined }) {
  if (!progress) return null;
  const { done, total, current, active } = progress;
  return (
    <span className="mt-1 flex min-w-0 items-center gap-2 text-small font-normal text-ink-3">
      {total <= 12 && (
        <span aria-hidden="true" className="flex shrink-0 gap-0.75">
          {Array.from({ length: total }, (_, index) => (
            <span
              key={index}
              className={cn(
                'h-1 w-3 rounded-full',
                index === current ? 'bg-running' : index < done ? 'bg-done' : 'bg-line-strong',
              )}
            />
          ))}
        </span>
      )}
      <span className="shrink-0">
        {done} of {total} done
      </span>
      {active && <span className="truncate">{active}</span>}
    </span>
  );
}
