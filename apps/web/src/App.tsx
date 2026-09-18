import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './admin/AdminPage';
import { DashboardPage } from './analytics/DashboardPage';
import { FunnelPage } from './funnel/FunnelPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/f/:funnelId" element={<FunnelPage />} />
        <Route path="/analytics" element={<DashboardPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to={{ pathname: '/f/workstyle-planner', search: window.location.search }} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
