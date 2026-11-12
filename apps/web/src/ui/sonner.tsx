import { Toaster as Sonner } from 'sonner';
import { StatusMarker } from './status';

// shadcn/ui sonner, restyled. Toasts exist for one case only: a background operation failed
// (toast.error). Success is visible in the page itself and never gets a toast.
function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      // On a phone, above the tab bar.
      mobileOffset={{ bottom: 72 }}
      icons={{ error: <StatusMarker status="failed" className="mt-[3px]" /> }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-89 max-w-full items-start gap-2.5 rounded-xl border border-line-strong bg-raised p-3.5 text-ui text-ink shadow-overlay',
          title: 'font-medium',
          description: 'text-ink-2',
        },
      }}
    />
  );
}

export { Toaster };
