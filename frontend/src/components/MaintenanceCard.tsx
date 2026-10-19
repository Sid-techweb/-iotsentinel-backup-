import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, Maintenance, useLive } from '../api';
import { useAuth } from '../auth';
import { timeAgo } from '../format';
import { Badge, Card, Empty, Modal, toast } from './ui';

const KINDS = ['inspection', 'repair', 'replacement', 'calibration', 'note'] as const;
const TONE: Record<Maintenance['kind'], 'ok' | 'warn' | 'info' | 'pred' | 'accent' | ''> = {
  inspection: 'info', repair: 'warn', replacement: 'warn', calibration: 'accent', firmware: 'pred', activation: '', note: '',
};

/** A machine's maintenance history: manual entries plus automatic ones (firmware updates, activation changes). */
export default function MaintenanceCard({ deviceId }: { deviceId: string }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const { data } = useLive<Maintenance[]>(`/devices/${deviceId}/maintenance`, 20000);
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/devices/${deviceId}/maintenance/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/devices/${deviceId}/maintenance`] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <Card title="Maintenance history" sub="Inspections, repairs and automatic entries"
      action={<button className="btn sm" disabled={!isAdmin} onClick={() => setAdding(true)}><Plus size={13} />Add entry</button>} flush>
      {!data?.length ? <Empty>No maintenance recorded yet.</Empty> : (
        <ul className="feed" style={{ maxHeight: 320, overflow: 'auto' }}>
          {data.map((m) => (
            <li key={m.id} style={{ gridTemplateColumns: '1fr auto' }}>
              <div>
                <div className="row" style={{ gap: 8 }}><Badge tone={TONE[m.kind]}>{m.kind}</Badge><span className="strong">{m.summary}</span></div>
                {m.details && <div className="muted small" style={{ marginTop: 3 }}>{m.details}</div>}
                <div className="muted small" style={{ marginTop: 3 }}>{m.performedByName} · {timeAgo(m.performedAt)}</div>
              </div>
              {isAdmin && m.kind !== 'firmware' && m.kind !== 'activation' && (
                <button className="btn sm ghost danger" aria-label="Delete entry" onClick={() => confirm('Delete this maintenance entry?') && remove.mutate(m.id)}><Trash2 size={12} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <AddModal deviceId={deviceId} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddModal({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<(typeof KINDS)[number]>('inspection');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/devices/${deviceId}/maintenance`, { kind, summary, details }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [`/devices/${deviceId}/maintenance`] }); toast('Entry added'); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Modal title="Add maintenance entry" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={save.isPending || summary.trim().length < 3} onClick={() => save.mutate()}>Save</button></>}>
      <label className="field">Type<select className="input" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
      <label className="field">Summary<input className="input" autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Replaced coolant pump" maxLength={200} /></label>
      <label className="field">Details (optional)<textarea className="input" rows={3} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} /></label>
    </Modal>
  );
}
