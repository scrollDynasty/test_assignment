import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { FunnelPage } from './funnel/FunnelPage';

// The internal area is loaded only when opened: visitors of the funnel never download the dashboard or the admin page.
const AdminPage = lazy(() => import('./admin/AdminPage').then((m) => ({ default: m.AdminPage })));
const DashboardPage = lazy(() => import('./analytics/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const InternalGate = lazy(() => import('./internal/InternalGate').then((m) => ({ default: m.InternalGate })));

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="spinner" />}>
        <Routes>
          {/* Public: what visitors see. */}
          <Route path="/f/:funnelId" element={<FunnelPage />} />
          {/* Internal area: behind a login, not linked from the funnel. */}
          <Route path="/internal/analytics" element={<InternalGate><DashboardPage /></InternalGate>} />
          <Route path="/internal/versions" element={<InternalGate><AdminPage /></InternalGate>} />
          <Route path="/internal" element={<Navigate to="/internal/analytics" replace />} />
          <Route path="*" element={<Navigate to={{ pathname: '/f/workstyle-planner', search: window.location.search }} replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
