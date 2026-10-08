import { Activity, BrainCircuit, ShieldCheck, Wrench } from 'lucide-react';
import { FormEvent, ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

function AuthLayout({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="brand"><div className="brand-mark"><Activity size={18} strokeWidth={2.6} /></div><div>IoT Sentinel</div></div>
        <h2>See every device. Fix problems before they happen.</h2>
        <ul>
          <li><BrainCircuit size={18} /><span><b>Predictive alerts</b>A model forecasts threshold breaches ahead of time.</span></li>
          <li><Wrench size={18} /><span><b>Firmware control</b>Track versions and roll out updates safely.</span></li>
          <li><ShieldCheck size={18} /><span><b>Security incidents</b>One triage queue for the whole fleet.</span></li>
        </ul>
      </aside>
      <main className="auth-form">
        <div className="auth-card">
          <h1>{title}</h1>
          <p className="muted">{sub}</p>
          {children}
        </div>
      </main>
    </div>
  );
}

function useSubmit(action: () => Promise<void>) {
  const nav = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try { await action(); nav('/', { replace: true }); } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); } finally { setBusy(false); }
  };
  return { submit, error, busy };
}

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { submit, error, busy } = useSubmit(() => login(email, password));
  return (
    <AuthLayout title="Welcome back" sub="Sign in to your monitoring console.">
      <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
        <label className="field">Email<input className="input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field">Password<input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn primary" style={{ justifyContent: 'center' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="muted small">New here? <Link to="/register" className="link">Create an account</Link></p>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const { submit, error, busy } = useSubmit(() => register(f.name, f.email, f.password));
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <AuthLayout title="Create your account" sub="The first account on a new installation becomes the administrator; later accounts are read-only until promoted.">
      <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
        <label className="field">Name<input className="input" required minLength={2} autoComplete="name" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">Email<input className="input" type="email" required autoComplete="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></label>
        <label className="field">Password (min. 8 characters)<input className="input" type="password" required minLength={8} autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} /></label>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn primary" style={{ justifyContent: 'center' }} disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
      <p className="muted small">Already registered? <Link to="/login" className="link">Sign in</Link></p>
    </AuthLayout>
  );
}
