import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('keeps our text sizes next to text colors', () => {
    expect(cn('text-ui', 'text-ink-2')).toBe('text-ui text-ink-2');
    expect(cn('text-small text-ink-3', 'text-section')).toBe('text-ink-3 text-section');
  });

  it('lets a later class of the same kind win', () => {
    expect(cn('px-3', 'px-2.5')).toBe('px-2.5');
    expect(cn('shadow-overlay', 'shadow-none')).toBe('shadow-none');
  });
});
