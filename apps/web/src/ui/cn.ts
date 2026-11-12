import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge only knows Tailwind's default scale. Without these names it would read
// `text-ui` as a color and drop it next to `text-ink-2`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['small', 'ui', 'read', 'section', 'title', 'name'],
      shadow: ['overlay'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
