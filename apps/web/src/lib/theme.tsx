import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useI18n } from '../i18n';
import { viewTransition } from './transition';

type Theme = 'light' | 'dark';
const KEY = 'funnel:theme'; // also read by public/theme-init.js before the first paint

const systemTheme = (): Theme => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

function currentTheme(): Theme {
  const set = document.documentElement.getAttribute('data-theme');
  return set === 'light' || set === 'dark' ? set : systemTheme();
}

/** Browser UI colour (mobile address bar) follows the chosen theme, not only the system one. */
const GROUND: Record<Theme, string> = { light: '#f2f3ee', dark: '#111512' };

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', GROUND[theme]));
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

/**
 * Light/dark switch. The new theme spreads from the button as a growing circle ("wave") over the whole page:
 * the View Transitions API snapshots the page in the old theme, the theme is applied, and the new snapshot is
 * revealed with a clip-path circle from the button's centre to the farthest corner of the screen. Without the
 * API, or with reduced motion, the theme simply switches.
 */
export function ThemeToggle() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>(currentTheme);

  // Follow the system while the visitor has not chosen (e.g. the OS switches to dark in the evening).
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(currentTheme());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    // Centre of the wave: the icon itself (also correct for keyboard activation, where there is no pointer).
    const r = e.currentTarget.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    viewTransition(
      () => {
        // Decided when the transition runs, not on click: a second click queued behind a running wave flips back.
        const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        setTheme(next);
      },
      {
        variant: 'theme',
        onReady: () => {
          document.documentElement.animate(
            { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
            { duration: 750, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', pseudoElement: '::view-transition-new(root)' },
          );
        },
      },
    );
  }, []);

  const label = theme === 'dark' ? t('theme.toLight') : t('theme.toDark');
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label={label} title={label}>
      {/* Shows where the click leads: a moon in the light theme, a sun in the dark one. One drawing morphs between
          them: the moon is the disc grown and bitten, the rays fold away. */}
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className={theme === 'light' ? 'is-moon' : ''}>
        <mask id="theme-bite">
          <rect width="24" height="24" fill="#fff" />
          <circle className="bite" cx="17" cy="7" r="6" fill="#000" />
        </mask>
        <circle className="disc" cx="12" cy="12" r="5" fill="currentColor" mask="url(#theme-bite)" />
        <g className="rays" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 1.5v2M12 20.5v2M1.5 12h2M20.5 12h2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M4.6 19.4 6 18M18 6l1.4-1.4" />
        </g>
      </svg>
    </button>
  );
}
