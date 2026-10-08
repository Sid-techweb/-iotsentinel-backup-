import { Activity, BellRing, BrainCircuit, Cpu, History, LayoutDashboard, LogOut, Moon, ShieldAlert, SlidersHorizontal, Sun, UserRound, Wrench } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Summary, useLive } from './api';
import { useAuth } from './auth';
import { Toaster } from './components/ui';
import Account from './pages/Account';
import Activity_ from './pages/Activity';
import Alerts from './pages/Alerts';
import Anomaly from './pages/Anomaly';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import Dashboard from './pages/Dashboard';
import DeviceDetail from './pages/DeviceDetail';
import Devices from './pages/Devices';
import Firmware from './pages/Firmware';
import Incidents from './pages/Incidents';
import Rules from './pages/Rules';

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return <div className="empty">Loading…</div>;

  return (
    <>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="/register" element={user ? <Navigate to="/" replace /> : <RegisterPage />} />
        <Route path="/*" element={user ? <Shell /> : <Navigate to="/login" replace />} />
      </Routes>
      <Toaster />
    </>
  );
}

function Shell() {
  const { user, logout } = useAuth();
  const { data: summary, isError } = useLive<Summary>('/dashboard/summary', 4000);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark');
  const activeAlerts = summary?.alerts.reduce((n, a) => n + a.count, 0) ?? 0;

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
    setTheme(next);
  };

  const link = (to: string, icon: ReactNode, label: string, count?: number) => (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
      {icon}<span className="txt">{label}</span>{!!count && <span className="count">{count}</span>}
    </NavLink>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Activity size={18} strokeWidth={2.6} /></div>
          <div>IoT Sentinel<small>Health &amp; security monitor</small></div>
        </div>
        <nav className="nav">
          <div className="nav-label">Monitor</div>
          {link('/', <LayoutDashboard size={17} />, 'Dashboard')}
          {link('/devices', <Cpu size={17} />, 'Devices')}
          {link('/alerts', <BellRing size={17} />, 'Alerts', activeAlerts)}
          {link('/anomaly', <BrainCircuit size={17} />, 'Anomaly Prediction')}
          {link('/activity', <History size={17} />, 'Activity')}
          <div className="nav-label">Manage</div>
          {link('/firmware', <Wrench size={17} />, 'Firmware')}
          {link('/incidents', <ShieldAlert size={17} />, 'Security Incidents')}
          {link('/rules', <SlidersHorizontal size={17} />, 'Alert Rules')}
          {link('/account', <UserRound size={17} />, 'Account')}
        </nav>
        <div className="side-foot">
          <div className="live"><span className={`pulse ${isError ? 'down' : ''}`} />{isError ? 'API unreachable' : 'Live - updating'}</div>
          <div className="who">
            <div className="avatar" aria-hidden>{user?.name.slice(0, 1).toUpperCase()}</div>
            <div style={{ minWidth: 0 }}>
              <div className="strong ellipsis">{user?.name}</div>
              <div className="small">{user?.role === 'admin' ? 'Administrator' : 'Viewer · read-only'}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={toggle} aria-label="Toggle theme">{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}{theme === 'dark' ? 'Light' : 'Dark'}</button>
            <button className="btn sm" onClick={logout}><LogOut size={14} />Sign out</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/:id" element={<DeviceDetail />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/anomaly" element={<Anomaly />} />
          <Route path="/activity" element={<Activity_ />} />
          <Route path="/firmware" element={<Firmware />} />
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/account" element={<Account />} />
          <Route path="*" element={<div className="empty">Page not found</div>} />
        </Routes>
      </main>
    </div>
  );
}
