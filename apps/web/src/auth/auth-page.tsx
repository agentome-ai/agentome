import { type ReactNode, useEffect, useRef } from 'react';
import { hideSplash } from '../shell/splash';
import { Logo } from '../ui/logo';

/**
 * The pages before the shell: one centred card on paper, so the form reads as a deliberate panel
 * at any width instead of a column hung in an empty screen. The card is a contained unit, so an
 * error appearing under a field grows it in place without moving anything around it.
 */
export function AuthPage(props: { title: string; description?: ReactNode; children?: ReactNode }) {
  useEffect(hideSplash, []);
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-4 py-16">
      <div className="grid w-full max-w-96 justify-items-center gap-7">
        {/* Where you are before what to do: the product's logo, quiet, over the form. */}
        <Logo className="h-7" />
        <div className="w-full rounded-xl border border-line bg-raised p-8 max-md:p-6">
          <h1 className="text-title">{props.title}</h1>
          {props.description && <p className="mt-1.5 text-read text-ink-2">{props.description}</p>}
          {props.children && <div className="mt-7">{props.children}</div>}
        </div>
      </div>
    </main>
  );
}

/** After a submit with errors, focus goes to the first field in error, which reads its message. */
export function useFocusFirstError(errors: object) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);
  return form;
}

// A simple shape check; the server checks the address properly.
export const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
