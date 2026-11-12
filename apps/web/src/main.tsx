// One variable file per family: every weight the tokens name, self-hosted (no CDN).
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { App } from './app';
import { loadNewVersions } from './shell/fresh';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

// A data router, so that a page can hold a navigation (useBlocker): the agent editor asks
// before unsaved edits are left behind. Its one route is the app, which keeps its <Routes>.
const router = createBrowserRouter([{ path: '*', element: <App /> }]);
loadNewVersions(router);

// It only shows pushes (public/sw.js); a browser without it, or off https, does without.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
