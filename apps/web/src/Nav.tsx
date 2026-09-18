import { NavLink } from 'react-router-dom';
import { LangSwitch, useI18n } from './i18n';

export function Nav() {
  const { t } = useI18n();
  return (
    <nav className="nav">
      <span className="brand">{t('nav.brand')}</span>
      <NavLink to="/f/workstyle-planner">{t('nav.funnel')}</NavLink>
      <NavLink to="/analytics">{t('nav.analytics')}</NavLink>
      <NavLink to="/admin">{t('nav.versions')}</NavLink>
      <span className="spacer" />
      <LangSwitch />
    </nav>
  );
}
