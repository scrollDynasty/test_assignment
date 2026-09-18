import { NavLink } from 'react-router-dom';

export function Nav() {
  return (
    <nav className="nav">
      <span className="brand">Funnel Runtime</span>
      <NavLink to="/f/workstyle-planner">Funnel</NavLink>
      <NavLink to="/analytics">Analytics</NavLink>
      <NavLink to="/admin">Versions</NavLink>
    </nav>
  );
}
