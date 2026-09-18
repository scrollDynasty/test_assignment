import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { FunnelPage } from './funnel/FunnelPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/f/:funnelId" element={<FunnelPage />} />
        <Route path="*" element={<Navigate to={{ pathname: '/f/workstyle-planner', search: window.location.search }} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
