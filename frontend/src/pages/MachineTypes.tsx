import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Brain, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, DeviceType, METRIC_KEYS, METRIC_META, MetricKey, useLive } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, Modal, PageHead, toast } from '../components/ui';
import { timeAgo } from '../format';

export default function MachineTypes() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const { data } = useLive<DeviceType[]>('/device-types', 10000);
  const [editing, setEditing] = useState<DeviceType | 'new' | null>(null);

  const remove = useMutation({
    mutationFn: (t: DeviceType) => api.del(`/device-types/${t.id}`),
    onSuccess: () => { qc.invalidateQueries(); toast('Machine type removed'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <>
      <PageHead title="Machine types" desc="Each kind of machine reports its own signals, has its own alert limits and can have its own prediction model.">
        <button className="btn primary" disabled={!isAdmin} onClick={() => setEditing('new')}><Plus size={15} />New machine type</button>
      </PageHead>

      {!data ? <div className="empty">Loading…</div> : (
        <div className="grid g2">
          {data.map((t) => (
            <Card key={t.id} title={t.name} sub={t.description || undefined}
              action={isAdmin && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={() => setEditing(t)}><Pencil size={12} />Edit</button>
                  <button className="btn sm danger" disabled={t.deviceCount > 0 || remove.isPending} title={t.deviceCount > 0 ? 'Move or remove its devices first' : undefined}
                    onClick={() => confirm(`Delete machine type "${t.name}"? Its limit overrides and model are removed too.`) && remove.mutate(t)}><Trash2 size={12} /></button>
                </div>
              )}>
              <div className="stack" style={{ gap: 12 }}>
                <div>
                  <div className="muted small" style={{ marginBottom: 6 }}>Reports {t.metrics.length} signals</div>
                  <div className="chips">{t.metrics.map((m) => <Badge key={m} tone="accent">{METRIC_META[m].label}</Badge>)}</div>
                </div>
                <dl className="kv" style={{ margin: 0 }}>
                  <dt>Devices</dt><dd>{t.deviceCount}</dd>
                  <dt>Prediction model</dt>
                  <dd>{t.model
                    ? <Badge tone="pred"><Brain size={12} />own · {t.model.source} · {timeAgo(t.model.trainedAt)}</Badge>
                    : <span className="muted">uses the global model</span>}</dd>
                </dl>
              </div>
            </Card>
          ))}
          {!data.length && <Card><Empty>No machine types yet.</Empty></Card>}
        </div>
      )}
      {editing && <TypeModal type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function TypeModal({ type, onClose }: { type: DeviceType | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(type?.name ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [metrics, setMetrics] = useState<MetricKey[]>(type?.metrics ?? ['temperature', 'cpu', 'memory', 'signal']);

  const save = useMutation({
    mutationFn: () => (type
      ? api.put(`/device-types/${type.id}`, { description, metrics })
      : api.post('/device-types', { name, description, metrics })),
    onSuccess: () => { qc.invalidateQueries(); toast(type ? 'Machine type updated' : 'Machine type created'); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const toggle = (m: MetricKey) => setMetrics((x) => (x.includes(m) ? x.filter((k) => k !== m) : [...x, m]));

  return (
    <Modal title={type ? `Edit ${type.name}` : 'New machine type'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={save.isPending || name.trim().length < 2 || !metrics.length} onClick={() => save.mutate()}>{type ? 'Save' : 'Create'}</button></>}>
      <label className="field">Name<input className="input" autoFocus disabled={!!type} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Air Compressor" /></label>
      <label className="field">Description<input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this machine?" /></label>
      <div className="field">Signals this machine reports
        <div className="form-2" style={{ marginTop: 6 }}>
          {METRIC_KEYS.map((m) => (
            <label key={m} className="check"><input type="checkbox" checked={metrics.includes(m)} onChange={() => toggle(m)} />{METRIC_META[m].label}<span className="muted small">{METRIC_META[m].unit.trim()}</span></label>
          ))}
        </div>
      </div>
      <div className="muted small">Alert limits start from the defaults; override them per machine type under Alert Rules.</div>
    </Modal>
  );
}
