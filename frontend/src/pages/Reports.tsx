import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Download, FileText, Loader2, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Device, DeviceType, downloadFile } from '../api';
import { Badge, Card, Empty, ErrorBox, PageHead, toast } from '../components/ui';

interface Catalogue { id: string; title: string; description: string; uses: string[]; note: string | null }
interface Col { key: string; header: string; fmt?: 'time' | 'num1' | 'pct' | 'bool' }
interface Preview {
  report: { id: string; title: string }; generatedAt: string; columns: Col[]; rows: Record<string, unknown>[]; total: number;
  scope: { devices: number; simulatedDevices: number }; notes: string[];
}

const PERIODS = [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']] as const;

function cell(c: Col, v: unknown) {
  if (v === null || v === undefined || v === '') return <span className="muted">-</span>;
  if (c.fmt === 'bool') return v ? 'yes' : 'no';
  if (c.fmt === 'time') return new Date(v as string).toLocaleString();
  if (c.fmt === 'pct') return `${Math.round(Number(v) * 100)}%`;
  if (c.fmt === 'num1') return String(Math.round(Number(v) * 100) / 100);
  return String(v);
}

/** Reports: preview on screen, download as CSV (complete data) or PDF (for reading). */
export default function Reports() {
  const { data: list, error } = useQuery({ queryKey: ['/reports'], queryFn: () => api.get<Catalogue[]>('/reports') });
  const { data: types } = useQuery({ queryKey: ['/device-types'], queryFn: () => api.get<DeviceType[]>('/device-types') });
  const { data: devices } = useQuery({ queryKey: ['/devices'], queryFn: () => api.get<Device[]>('/devices') });
  const [id, setId] = useState('device-health');
  const [days, setDays] = useState('7');
  const [type, setType] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [sim, setSim] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const def = list?.find((r) => r.id === id);
  const uses = def?.uses ?? [];

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (uses.includes('range')) {
      const to = new Date();
      p.set('from', new Date(to.getTime() - Number(days) * 86_400_000).toISOString());
      p.set('to', to.toISOString());
    }
    if (uses.includes('machineType') && type) p.set('machineType', type);
    if (uses.includes('device') && deviceId) p.set('deviceId', deviceId);
    if (uses.includes('simulated') && !sim) p.set('includeSimulated', 'false');
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [uses, days, type, deviceId, sim]);

  const { data: pv, error: pvError, isFetching } = useQuery({
    queryKey: ['/reports/preview', id, qs],
    queryFn: () => api.get<Preview>(`/reports/${id}${qs}`),
    enabled: !!def,
    placeholderData: (prev) => prev,
  });

  async function download(kind: 'csv' | 'pdf') {
    setBusy(kind);
    try { await downloadFile(`/reports/${id}/${kind}${qs}`, `${id}-${new Date().toISOString().slice(0, 10)}.${kind}`); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  }

  const periodText = PERIODS.find(([d]) => d === days)?.[1].toLowerCase() ?? `last ${days} days`;
  const question = `Explain the ${def?.title.toLowerCase() ?? 'report'} for the ${uses.includes('range') ? periodText : 'current state'}${type ? ` for ${type} machines` : ''}: what stands out and what should I check first?`;

  return (
    <>
      <PageHead title="Reports" desc="Preview a report, then download the complete data as CSV or a readable PDF.">
        <Link to={`/assistant?q=${encodeURIComponent(question)}`} className="btn"><Sparkles size={15} />Explain with assistant</Link>
        <button className="btn" disabled={!!busy || !pv} onClick={() => void download('csv')}>{busy === 'csv' ? <Loader2 size={15} className="spin" /> : <Download size={15} />}CSV</button>
        <button className="btn primary" disabled={!!busy || !pv} onClick={() => void download('pdf')}>{busy === 'pdf' ? <Loader2 size={15} className="spin" /> : <FileText size={15} />}PDF</button>
      </PageHead>

      {error ? <ErrorBox error={error} /> : (
        <div className="grid g-main" style={{ gridTemplateColumns: 'minmax(220px, 300px) minmax(0, 1fr)', alignItems: 'start' }}>
          <Card title="Report" flush>
            <ul className="chat-list" style={{ padding: '4px 8px 12px' }} aria-label="Reports">
              {list?.map((r) => (
                <li key={r.id} className={r.id === id ? 'on' : ''}>
                  <button className="chat-item" onClick={() => setId(r.id)} aria-pressed={r.id === id}>
                    <span className="strong">{r.title}</span>
                    <span className="small muted">{r.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <div className="stack">
            <Card title={def?.title ?? 'Report'} sub={def?.description}>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                {uses.includes('range') && (
                  <label className="field">Period
                    <select className="input" value={days} onChange={(e) => setDays(e.target.value)}>{PERIODS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}</select>
                  </label>
                )}
                {uses.includes('machineType') && (
                  <label className="field">Machine type
                    <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                      <option value="">All types</option>{types?.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                    </select>
                  </label>
                )}
                {uses.includes('device') && (
                  <label className="field">Device
                    <select className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                      <option value="">All devices</option>{devices?.map((d) => <option key={d.id} value={d.id}>#{d.assetNo} {d.name}</option>)}
                    </select>
                  </label>
                )}
                {uses.includes('simulated') && (
                  <label className="check small"><input type="checkbox" checked={sim} onChange={(e) => setSim(e.target.checked)} />Include simulated devices</label>
                )}
                {isFetching && <Loader2 size={15} className="spin muted" />}
              </div>
              {pv?.notes.map((n, i) => <div key={i} className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}><AlertTriangle size={16} /><div className="small">{n}</div></div>)}
            </Card>

            <Card title="Preview" sub={pv ? `${pv.total.toLocaleString()} row${pv.total === 1 ? '' : 's'}${pv.total > pv.rows.length ? ` - showing the first ${pv.rows.length}` : ''} · generated ${new Date(pv.generatedAt).toLocaleTimeString()}` : undefined} flush>
              {pvError ? <div style={{ padding: 16 }}><ErrorBox error={pvError} /></div> : !pv ? <Empty>Loading…</Empty> : !pv.rows.length ? <Empty>No rows match these filters.</Empty> : (
                <div className="table-wrap"><table>
                  <thead><tr>{pv.columns.map((c) => <th key={c.key}>{c.header}</th>)}</tr></thead>
                  <tbody>
                    {pv.rows.map((r, i) => (
                      <tr key={i}>{pv.columns.map((c) => (
                        <td key={c.key} className="nowrap">
                          {cell(c, r[c.key])}{c.key === 'simulated' && r[c.key] ? <> <Badge tone="info">sim</Badge></> : null}
                        </td>
                      ))}</tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
