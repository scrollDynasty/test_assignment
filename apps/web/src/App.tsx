import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './admin/AdminPage';
import { DashboardPage } from './analytics/DashboardPage';
import { FunnelPage } from './funnel/FunnelPage';
import { InternalGate } from './internal/InternalGate';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public: what visitors see. */}
        <Route path="/f/:funnelId" element={<FunnelPage />} />
        {/* Internal area (TZ: "внутренняя страница", "внутренний dashboard"): behind a login, not linked from the funnel. */}
        <Route path="/internal/analytics" element={<InternalGate><DashboardPage /></InternalGate>} />
        <Route path="/internal/versions" element={<InternalGate><AdminPage /></InternalGate>} />
        <Route path="/internal" element={<Navigate to="/internal/analytics" replace />} />
        <Route path="*" element={<Navigate to={{ pathname: '/f/workstyle-planner', search: window.location.search }} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
