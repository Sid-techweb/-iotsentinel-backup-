import { Activity, BellRing, BookOpen, BrainCircuit, FileBarChart, Boxes, Sparkles, Cpu, History, ScrollText, LayoutDashboard, LogOut, Moon, Send, ShieldAlert, SlidersHorizontal, Sun, UserRound, Users, Wrench } from 'lucide-react';
import { lazy, ReactNode, Suspense, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Summary, useLive } from './api';
import { useAuth } from './auth';
import { Toaster } from './components/ui';
import { usePushConnected } from './live';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { useEventStream } from './useEventStream';

// every screen is a separate chunk, downloaded the first time it is opened
const Account = lazy(() => import('./pages/Account'));
const Activity_ = lazy(() => import('./pages/Activity'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Anomaly = lazy(() => import('./pages/Anomaly'));
const Assistant = lazy(() => import('./pages/Assistant'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const DeviceDetail = lazy(() => import('./pages/DeviceDetail'));
const Devices = lazy(() => import('./pages/Devices'));
const Firmware = lazy(() => import('./pages/Firmware'));
const Incidents = lazy(() => import('./pages/Incidents'));
const MachineTypes = lazy(() => import('./pages/MachineTypes'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Reports = lazy(() => import('./pages/Reports'));
const Rules = lazy(() => import('./pages/Rules'));
const UsersPage = lazy(() => import('./pages/Users'));
const AuditLog = lazy(() => import('./pages/AuditLog'));

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
  const { user, logout, isAdmin } = useAuth();
  useEventStream(true);
  const push = usePushConnected();
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
          {link('/reports', <FileBarChart size={17} />, 'Reports')}
          <div className="nav-label">Assistant</div>
          {link('/assistant', <Sparkles size={17} />, 'AI Assistant')}
          {link('/knowledge', <BookOpen size={17} />, 'Knowledge Base')}
          <div className="nav-label">Manage</div>
          {link('/firmware', <Wrench size={17} />, 'Firmware')}
          {link('/incidents', <ShieldAlert size={17} />, 'Security Incidents')}
          {link('/types', <Boxes size={17} />, 'Machine Types')}
          {link('/rules', <SlidersHorizontal size={17} />, 'Alert Rules')}
          {isAdmin && link('/notifications', <Send size={17} />, 'Notifications')}
          {isAdmin && link('/users', <Users size={17} />, 'Users')}
          {isAdmin && link('/audit', <ScrollText size={17} />, 'Audit Log')}
          {link('/account', <UserRound size={17} />, 'Account')}
        </nav>
        <div className="side-foot">
          <div className="live"><span className={`pulse ${isError ? 'down' : ''}`} />{isError ? 'API unreachable' : push ? 'Live - push updates' : 'Live - polling'}</div>
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
        <Suspense fallback={<div className="empty">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/:id" element={<DeviceDetail />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/anomaly" element={<Anomaly />} />
          <Route path="/activity" element={<Activity_ />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/knowledge" element={<KnowledgeBase />} />
          <Route path="/firmware" element={<Firmware />} />
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/types" element={<MachineTypes />} />
          <Route path="/notifications" element={isAdmin ? <Notifications /> : <Navigate to="/" replace />} />
          <Route path="/users" element={isAdmin ? <UsersPage /> : <Navigate to="/" replace />} />
          <Route path="/audit" element={isAdmin ? <AuditLog /> : <Navigate to="/" replace />} />
          <Route path="/account" element={<Account />} />
          <Route path="*" element={<div className="empty">Page not found</div>} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
