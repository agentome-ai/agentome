import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// A page in a test loads through the stubbed API in milliseconds here, but on a GitHub runner a
// findBy or waitFor took over two seconds, past the library's default second. As the test timeout
// does, the wait leaves room for a slow CI runner.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

// jsdom has no layout: stub the browser APIs that the shell, Radix and cmdk call.
window.matchMedia = (media: string) =>
  ({
    matches: false,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }) as unknown as MediaQueryList;

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

Element.prototype.scrollIntoView = () => undefined;
window.scrollTo = () => undefined;
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => undefined;
