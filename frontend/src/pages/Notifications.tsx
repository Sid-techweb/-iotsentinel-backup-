import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, History, Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, Delivery, Webhook, useLive } from '../api';
import { Badge, Card, Empty, Modal, PageHead, toast } from '../components/ui';
import { timeAgo } from '../format';

interface Listing { events: string[]; webhooks: Webhook[] }

const EVENT_LABEL: Record<string, string> = {
  'alert.critical': 'Critical alerts',
  'alert.predictive': 'Predictive alerts (before a breach)',
  'incident.created': 'High / critical security incidents',
};

export default function Notifications() {
  const qc = useQueryClient();
  const { data } = useLive<Listing>('/webhooks', 10000);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<Webhook | null>(null);
  const [history, setHistory] = useState<Webhook | null>(null);

  const toggle = useMutation({
    mutationFn: (w: Webhook) => api.put(`/webhooks/${w.id}`, { enabled: !w.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/webhooks'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const test = useMutation({
    mutationFn: (w: Webhook) => api.post<{ ok: boolean; statusCode: number | null; error: string | null }>(`/webhooks/${w.id}/test`),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['/webhooks'] }); toast(r.ok ? `Test delivered (HTTP ${r.statusCode})` : `Test failed: ${r.error}`, r.ok ? 'success' : 'error'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: (w: Webhook) => api.del(`/webhooks/${w.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/webhooks'] }); toast('Webhook deleted'); },
  });

  return (
    <>
      <PageHead title="Notifications" desc="Send alerts and incidents to Slack, Discord, Teams or any HTTPS endpoint the moment they happen.">
        <button className="btn primary" onClick={() => setAdding(true)}><Plus size={15} />Add webhook</button>
      </PageHead>

      <Card flush>
        {!data?.webhooks.length ? <Empty>No webhooks yet. Add one to be told about critical alerts and predicted breaches.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Sends</th><th>Last delivery</th><th>On</th><th /></tr></thead>
            <tbody>
              {data.webhooks.map((w) => (
                <tr key={w.id}>
                  <td><div className="strong">{w.name}</div><div className="muted small mono ellipsis" style={{ maxWidth: 280 }}>{w.url}</div></td>
                  <td><div className="chips">{w.events.map((e) => <Badge key={e} tone={e.startsWith('alert.predictive') ? 'pred' : e.startsWith('alert') ? 'crit' : 'warn'}>{e}</Badge>)}</div></td>
                  <td>{w.lastDelivery
                    ? <><Badge tone={w.lastDelivery.ok ? 'ok' : 'crit'}>{w.lastDelivery.ok ? `delivered ${w.lastDelivery.statusCode}` : 'failed'}</Badge> <span className="muted small">{timeAgo(w.lastDelivery.createdAt)}</span></>
                    : <span className="muted">never</span>}</td>
                  <td><input type="checkbox" checked={w.enabled} onChange={() => toggle.mutate(w)} aria-label={`${w.name} enabled`} /></td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    <button className="btn sm" disabled={test.isPending} onClick={() => test.mutate(w)}><Send size={12} />Test</button>{' '}
                    <button className="btn sm" onClick={() => setHistory(w)}><History size={12} />Log</button>{' '}
                    <button className="btn sm danger" onClick={() => confirm(`Delete webhook "${w.name}"?`) && remove.mutate(w)}><Trash2 size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <p className="muted small" style={{ marginTop: 12 }}>
        Each request is signed: verify the <code>X-Sentinel-Signature</code> header (HMAC-SHA256 of the raw body with your webhook secret).
        URLs pointing at private or local network addresses are refused.
      </p>

      {adding && <AddModal events={data?.events ?? []} onClose={() => setAdding(false)} onCreated={(w) => { setAdding(false); setCreated(w); }} />}
      {created && (
        <Modal title="Webhook created" onClose={() => setCreated(null)} footer={<button className="btn primary" onClick={() => setCreated(null)}>I have saved it</button>}>
          <p style={{ margin: 0 }}>Copy the signing secret now - it is shown only once.</p>
          <div className="row"><input className="input mono" readOnly style={{ flex: 1 }} value={created.secret ?? ''} />
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(created.secret ?? ''); toast('Secret copied'); }}><Copy size={14} /></button></div>
          <pre className="code">{`expected = "sha256=" + HMAC_SHA256(secret, rawBody)\ncompare it with the X-Sentinel-Signature header`}</pre>
        </Modal>
      )}
      {history && <HistoryModal hook={history} onClose={() => setHistory(null)} />}
    </>
  );
}

function AddModal({ events, onClose, onCreated }: { events: string[]; onClose: () => void; onCreated: (w: Webhook) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [picked, setPicked] = useState<string[]>(['alert.critical', 'alert.predictive']);
  const save = useMutation({
    mutationFn: () => api.post<Webhook>('/webhooks', { name, url, events: picked }),
    onSuccess: (w) => { qc.invalidateQueries({ queryKey: ['/webhooks'] }); onCreated(w); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Modal title="Add webhook" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={save.isPending || name.trim().length < 2 || !url || !picked.length} onClick={() => save.mutate()}>Create</button></>}>
      <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ops channel" /></label>
      <label className="field">Endpoint URL<input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/..." /></label>
      <div className="field">Send me
        <div className="stack" style={{ gap: 6, marginTop: 6 }}>
          {events.map((ev) => (
            <label key={ev} className="check"><input type="checkbox" checked={picked.includes(ev)} onChange={() => setPicked((p) => (p.includes(ev) ? p.filter((x) => x !== ev) : [...p, ev]))} />{EVENT_LABEL[ev] ?? ev}</label>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function HistoryModal({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const { data } = useLive<Delivery[]>(`/webhooks/${hook.id}/deliveries`, 5000);
  return (
    <Modal title={`Deliveries - ${hook.name}`} onClose={onClose}>
      {!data?.length ? <Empty>Nothing has been sent yet.</Empty> : (
        <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}><table>
          <thead><tr><th>When</th><th>Event</th><th>Result</th><th className="num">ms</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td className="muted nowrap">{timeAgo(d.createdAt)}</td>
                <td className="mono small">{d.event}</td>
                <td><Badge tone={d.ok ? 'ok' : 'crit'}>{d.ok ? `HTTP ${d.statusCode}` : d.error ?? 'failed'}</Badge></td>
                <td className="num">{d.durationMs}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Modal>
  );
}
