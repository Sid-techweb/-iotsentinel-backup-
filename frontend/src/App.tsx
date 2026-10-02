import { Activity, BellRing, BrainCircuit, Cpu, LayoutDashboard, Moon, ShieldAlert, SlidersHorizontal, Sun, Wrench } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Summary, useLive } from './api';
import { Toaster } from './components/ui';
import Alerts from './pages/Alerts';
import Anomaly from './pages/Anomaly';
import Dashboard from './pages/Dashboard';
import DeviceDetail from './pages/DeviceDetail';
import Devices from './pages/Devices';
import Firmware from './pages/Firmware';
import Incidents from './pages/Incidents';
import Rules from './pages/Rules';

export default function App() {
  const { data: summary, isError } = useLive<Summary>('/dashboard/summary', 4000);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark');
  const activeAlerts = summary?.alerts.reduce((n, a) => n + a.count, 0) ?? 0;

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
    setTheme(next);
  };

  const link = (to: string, icon: React.ReactNode, label: string, count?: number) => (
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
          <div className="nav-label">Manage</div>
          {link('/firmware', <Wrench size={17} />, 'Firmware')}
          {link('/incidents', <ShieldAlert size={17} />, 'Security Incidents')}
          {link('/rules', <SlidersHorizontal size={17} />, 'Alert Rules')}
        </nav>
        <div className="side-foot">
          <div className="live"><span className={`pulse ${isError ? 'down' : ''}`} />{isError ? 'API unreachable' : 'Live - updating'}</div>
          <button className="btn sm" onClick={toggle}>{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/devices/:id" element={<DeviceDetail />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/anomaly" element={<Anomaly />} />
          <Route path="/firmware" element={<Firmware />} />
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="*" element={<div className="empty">Page not found</div>} />
        </Routes>
      </main>
      <Toaster />
    </div>
  );
}
