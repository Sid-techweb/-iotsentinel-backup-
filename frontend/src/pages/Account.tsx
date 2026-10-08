import { FormEvent, useState } from 'react';
import { api, User } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, PageHead, toast } from '../components/ui';

export default function Account() {
  const { user, setUser, logout } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try { setUser(await api.patch<User>('/auth/me', { name, email })); toast('Profile updated'); } catch (err) { toast((err as Error).message, 'error'); }
  };
  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.next !== pw.confirm) return toast('New passwords do not match', 'error');
    try {
      await api.post('/auth/me/password', { current: pw.current, next: pw.next });
      setPw({ current: '', next: '', confirm: '' });
      toast('Password changed');
    } catch (err) { toast((err as Error).message, 'error'); }
  };

  return (
    <>
      <PageHead title="Account" desc="Your profile and sign-in details.">
        <Badge tone={user?.role === 'admin' ? 'accent' : ''}>{user?.role === 'admin' ? 'Administrator' : 'Viewer (read-only)'}</Badge>
      </PageHead>
      <div className="grid g2">
        <Card title="Profile">
          <form onSubmit={saveProfile} className="stack" style={{ gap: 14 }}>
            <label className="field">Name<input className="input" value={name} minLength={2} required onChange={(e) => setName(e.target.value)} /></label>
            <label className="field">Email<input className="input" type="email" value={email} required onChange={(e) => setEmail(e.target.value)} /></label>
            <div><button className="btn primary">Save changes</button></div>
          </form>
        </Card>
        <Card title="Change password">
          <form onSubmit={savePassword} className="stack" style={{ gap: 14 }}>
            <label className="field">Current password<input className="input" type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
            <label className="field">New password<input className="input" type="password" autoComplete="new-password" minLength={8} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
            <label className="field">Confirm new password<input className="input" type="password" autoComplete="new-password" minLength={8} required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></label>
            <div><button className="btn primary">Update password</button></div>
          </form>
        </Card>
        <Card title="Session">
          <p className="muted" style={{ marginTop: 0 }}>Sessions last 12 hours. Signing out clears this browser's token.</p>
          <button className="btn danger" onClick={logout}>Sign out</button>
        </Card>
      </div>
    </>
  );
}
