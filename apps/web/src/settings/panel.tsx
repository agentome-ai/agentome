import { type ReactNode, useId } from 'react';
import { cn } from '../ui/cn';

type ControlProps = { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string };

/**
 * A group of settings under its caption, as Admin's pages are listed: a bordered panel with a
 * hairline between its rows on a desk, More's raised group on a phone. Its footer holds the
 * group's button, so each group saves on its own.
 */
export function Panel(props: { title: string; children: ReactNode; footer?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="mb-2 text-small text-ink-3 max-md:mx-3.5 max-md:mb-1.5">
        {props.title}
      </h2>
      <div className="divide-y divide-line rounded-lg border border-line max-md:rounded-xl max-md:border-0 max-md:bg-raised">
        {props.children}
        {props.footer && (
          <div className="flex flex-wrap items-center justify-end gap-3 px-4 py-3 max-md:px-3.5">
            {props.footer}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * A setting: its label and the line under it on the left, its control on the right; on a phone
 * the control goes under the label. The line is the error when there is one, otherwise the hint,
 * and the control gets the id and aria attributes that tie them together, as Field's does.
 */
export function Row(props: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (control: ControlProps) => ReactNode;
}) {
  const id = useId();
  const note = props.error ?? props.hint;
  return (
    <div className="flex items-center gap-6 px-4 py-3 max-md:flex-col max-md:items-stretch max-md:gap-2 max-md:px-3.5">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <label htmlFor={id} className="font-medium">
          {props.label}
        </label>
        {note && (
          <p
            id={`${id}-note`}
            className={cn('text-small', props.error ? 'text-failed' : 'text-ink-3')}
          >
            {note}
          </p>
        )}
      </div>
      <div className="w-80 shrink-0 max-md:w-full">
        {props.children({
          id,
          'aria-invalid': props.error ? true : undefined,
          'aria-describedby': note ? `${id}-note` : undefined,
        })}
      </div>
    </div>
  );
}
