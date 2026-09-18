import { NavLink } from 'react-router-dom';
import { LangSwitch, useI18n } from './i18n';
import { logout } from './internal/InternalGate';

/** Navigation of the internal area; the public funnel has no links to it. */
export function Nav({ internal = true }: { internal?: boolean }) {
  const { t } = useI18n();
  return (
    <nav className="nav">
      <span className="brand"><span className="wordmark-glyph" aria-hidden="true" />{t('nav.brand')}</span>
      {internal && (
        <>
          <NavLink to="/internal/analytics">{t('nav.analytics')}</NavLink>
          <NavLink to="/internal/versions">{t('nav.versions')}</NavLink>
          <a href="/f/workstyle-planner" target="_blank" rel="noreferrer">{t('nav.funnel')} ↗</a>
        </>
      )}
      <span className="spacer" />
      <LangSwitch />
      {internal && (
        <button className="link logout" onClick={() => void logout()}>
          {t('nav.logout')}
        </button>
      )}
    </nav>
  );
}
