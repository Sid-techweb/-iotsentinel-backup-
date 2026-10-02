import { ReactNode, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { IncidentSeverity, RiskLevel, Severity, Status } from '../api';

type Tone = 'ok' | 'warn' | 'crit' | 'info' | 'pred' | 'accent' | '';

export const Badge = ({ tone = '', children }: { tone?: Tone; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;

const STATUS_TONE: Record<Status, Tone> = { online: 'ok', degraded: 'warn', offline: '' };
export const StatusBadge = ({ status }: { status: Status }) => (
  <Badge tone={STATUS_TONE[status]}><i className="dot" />{status}</Badge>
);

const SEV_TONE: Record<Severity | IncidentSeverity, Tone> = { info: 'info', low: 'info', warning: 'warn', medium: 'warn', high: 'crit', critical: 'crit' };
export const SeverityBadge = ({ severity }: { severity: Severity | IncidentSeverity }) => <Badge tone={SEV_TONE[severity]}>{severity}</Badge>;

export const RISK_COLOR: Record<RiskLevel, string> = { low: 'var(--ok)', elevated: 'var(--warn)', high: 'var(--crit)', breached: 'var(--crit)' };
const RISK_TONE: Record<RiskLevel, Tone> = { low: 'ok', elevated: 'warn', high: 'crit', breached: 'crit' };
export const RiskBadge = ({ level }: { level: RiskLevel }) => <Badge tone={RISK_TONE[level]}>{level === 'breached' ? 'breached' : `${level} risk`}</Badge>;

export const RiskBar = ({ p, level }: { p: number; level: RiskLevel }) => (
  <div className="risk-cell">
    <div className="bar"><i style={{ width: `${Math.round(p * 100)}%`, background: RISK_COLOR[level] }} /></div>
    <b>{Math.round(p * 100)}%</b>
  </div>
);

export function Card({ title, sub, action, children, flush, className = '' }: { title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          <div><h3>{title}</h3>{sub && <div className="sub">{sub}</div>}</div>
          {action}
        </div>
      )}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, note, tone = '', icon }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'ok' | 'warn' | 'crit' | 'pred' | ''; icon?: ReactNode }) {
  return (
    <div className={`card kpi tone-${tone}`}>
      <div className="label">{icon}{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export const PageHead = ({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) => (
  <div className="page-head">
    <div><h1>{title}</h1>{desc && <p>{desc}</p>}</div>
    <div className="row">{children}</div>
  </div>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const ErrorBox = ({ error }: { error: unknown }) => <div className="err">{error instanceof Error ? error.message : String(error)}</div>;

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><button className="btn sm ghost" onClick={onClose} aria-label="Close"><X size={15} /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---- tiny toast system ---- */
type ToastMsg = { id: number; text: string; kind: 'success' | 'error' };
let listeners: ((t: ToastMsg) => void)[] = [];
let toastId = 0;
export const toast = (text: string, kind: ToastMsg['kind'] = 'success') => listeners.forEach((l) => l({ id: ++toastId, text, kind }));

export function Toaster() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(() => {
    const l = (t: ToastMsg) => {
      setItems((x) => [...x, t]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), 3800);
    };
    listeners.push(l);
    return () => { listeners = listeners.filter((x) => x !== l); };
  }, []);
  return <div className="toasts" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>;
}
