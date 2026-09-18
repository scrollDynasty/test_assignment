import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import '@fontsource-variable/onest';
import '@fontsource-variable/geologica';
import './styles.css';

// A deploy replaces the hashed files; a page opened before it may ask for a chunk that no longer exists.
// Reload once to pick up the new version instead of showing a broken screen.
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (window.sessionStorage.getItem('funnel:reloaded-after-deploy') === '1') return;
    window.sessionStorage.setItem('funnel:reloaded-after-deploy', '1');
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

// The shell stays available while the server restarts (see public/sw.js). Production only: in development the
// worker would serve stale files.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
