import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { cn } from './cn';
import { Input } from './input';
import { StatusMarker } from './status';

type ControlProps = { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string };

/**
 * A label, its control and one line under it: the error when there is one, otherwise the
 * hint. The control gets the id and the aria attributes that tie the three together.
 */
export function Field(props: {
  label: string;
  hint?: string;
  error?: string;
  children: (control: ControlProps) => ReactNode;
}) {
  const id = useId();
  const note = props.error ?? props.hint;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-1.5">
      <label htmlFor={id} className="font-medium">
        {props.label}
      </label>
      {props.children({
        id,
        'aria-invalid': props.error ? true : undefined,
        'aria-describedby': note ? `${id}-note` : undefined,
      })}
      {note && (
        <p
          id={`${id}-note`}
          className={cn('text-small', props.error ? 'text-failed' : 'text-ink-3')}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/** A password field with Show and Hide: checking what you typed beats typing it twice blind. */
export function PasswordInput({ className, ...props }: ComponentProps<'input'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={shown ? 'text' : 'password'} className={cn('pr-14', className)} />
      <button
        type="button"
        onClick={() => setShown(!shown)}
        aria-label={`${shown ? 'Hide' : 'Show'} password`}
        className="absolute inset-y-1 right-1 rounded-sm px-2 text-small font-medium text-ink-2 hover:bg-hover hover:text-ink"
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/** What went wrong with a whole form or dialog, next to its button. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-failed">
      <StatusMarker status="failed" className="mt-[3px]" />
      {children}
    </p>
  );
}
