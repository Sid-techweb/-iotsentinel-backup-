import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, Download, FileText, Globe, Loader2, Lock, RefreshCw, Search, Trash2, UploadCloud } from 'lucide-react';
import { DragEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadFile, KbDocument, KbSearch, KbStatus, uploadForm, useLive } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, ErrorBox, Kpi, Modal, PageHead, toast } from '../components/ui';
import { timeAgo } from '../format';

const ACCEPT = '.pdf,.docx,.txt,.md,.csv';
const EXT = /\.(pdf|docx|txt|md|csv)$/i;

const STATUS: Record<KbDocument['status'], { tone: 'ok' | 'warn' | 'crit' | 'info'; label: string }> = {
  ready: { tone: 'ok', label: 'Ready' },
  queued: { tone: 'info', label: 'Queued' },
  processing: { tone: 'warn', label: 'Processing' },
  failed: { tone: 'crit', label: 'Failed' },
};

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

/** Documents the assistant can read: upload, search, share and remove them. */
export default function KnowledgeBase() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [busy, setBusy] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<KbDocument | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<KbSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const qs = new URLSearchParams();
  if (filter.trim().length) qs.set('q', filter.trim());
  if (status) qs.set('status', status);
  const path = `/knowledge${qs.size ? `?${qs}` : ''}`;
  const { data: docs, error } = useLive<KbDocument[]>(path, 4000);
  const { data: info } = useLive<KbStatus>('/knowledge/status', 15000);
  const refresh = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/knowledge') });

  async function upload(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const maxMb = info?.limits.maxUploadMb ?? 20;
      if (!EXT.test(file.name)) { toast(`${file.name}: only PDF, DOCX, TXT, MD and CSV files are supported`, 'error'); continue; }
      if (file.size > maxMb * 1048576) { toast(`${file.name} is larger than ${maxMb} MB`, 'error'); continue; }
      if (file.size === 0) { toast(`${file.name} is empty`, 'error'); continue; }
      setBusy((b) => [...b, file.name]);
      try {
        const form = new FormData();
        form.append('visibility', isAdmin ? visibility : 'private');
        form.append('file', file);
        await uploadForm('/knowledge', form);
        toast(`${file.name} uploaded - indexing started`);
      } catch (e) {
        toast(`${file.name}: ${(e as Error).message}`, 'error');
      } finally {
        setBusy((b) => b.filter((n) => n !== file.name));
        void refresh();
      }
    }
    if (input.current) input.current.value = '';
  }

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); };

  async function act(label: string, fn: () => Promise<unknown>) {
    try { await fn(); toast(label); } catch (e) { toast((e as Error).message, 'error'); } finally { void refresh(); }
  }

  async function runSearch() {
    if (query.trim().length < 2) return;
    setSearching(true);
    try { setResult(await api.get<KbSearch>(`/knowledge/search?q=${encodeURIComponent(query.trim())}`)); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setSearching(false); }
  }

  const provider = info?.provider;
  const noModels = provider && !provider.ok;

  return (
    <>
      <PageHead title="Knowledge Base" desc="Manuals, procedures and reports the AI Maintenance Assistant can read and cite. Your private documents are visible only to you.">
        <Link to="/assistant" className="btn primary"><BookOpen size={15} />Ask the assistant</Link>
      </PageHead>

      {noModels && (
        <div className="notice warn" role="alert">
          <AlertTriangle size={16} />
          <div>
            <b>The embedding service is not available.</b> Uploads are kept and will be indexed as soon as it is back.
            <div className="small">{provider.error ?? 'Start Ollama and install the models (see docs/DEPLOYMENT_GUIDE.md).'}</div>
          </div>
        </div>
      )}
      {provider?.ok && provider.embedModel && !provider.embedModel.available && (
        <div className="notice warn" role="alert"><AlertTriangle size={16} /><div><b>Embedding model {provider.embedModel.name} is not installed.</b> Run <code>ollama pull {provider.embedModel.name}</code>.</div></div>
      )}

      <div className="grid kpis">
        <Kpi label="Documents" value={info?.documents.total ?? '-'} note="you can read" />
        <Kpi label="Ready" value={info?.documents.ready ?? '-'} tone="ok" note="searchable by the assistant" />
        <Kpi label="In progress" value={(info?.documents.queued ?? 0) + (info?.documents.processing ?? 0)} tone={info && (info.documents.queued + info.documents.processing) > 0 ? 'warn' : ''} note="queued or processing" />
        <Kpi label="Failed" value={info?.documents.failed ?? '-'} tone={info?.documents.failed ? 'crit' : ''} note="retry from the list" />
      </div>

      <Card title="Upload documents" sub={`PDF, DOCX, TXT, Markdown or CSV - up to ${info?.limits.maxUploadMb ?? 20} MB each`}>
        <div
          className={`dropzone ${drag ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <UploadCloud size={26} />
          <div>Drag files here or <button className="link-btn" type="button" onClick={() => input.current?.click()}>choose files</button></div>
          <input ref={input} type="file" accept={ACCEPT} multiple hidden aria-label="Choose documents to upload" onChange={(e) => e.target.files && void upload(e.target.files)} />
          {isAdmin && (
            <label className="check small">
              <input type="checkbox" checked={visibility === 'shared'} onChange={(e) => setVisibility(e.target.checked ? 'shared' : 'private')} />
              Share with all users
            </label>
          )}
          {busy.length > 0 && <div className="small muted"><Loader2 size={13} className="spin" /> Uploading {busy.join(', ')}…</div>}
        </div>
      </Card>

      <div style={{ height: 16 }} />
      <Card title="Search the knowledge base" sub="Meaning-based search across the documents you can read">
        <form className="row" onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
          <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder="e.g. how to replace a spindle bearing" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the knowledge base" />
          <button className="btn" type="submit" disabled={searching || query.trim().length < 2}>{searching ? <Loader2 size={15} className="spin" /> : <Search size={15} />}Search</button>
        </form>
        {result && (
          <div style={{ marginTop: 12 }}>
            {result.note && <div className="notice warn"><AlertTriangle size={16} /><div>{result.note}</div></div>}
            {!result.results.length ? <Empty>No passages matched.</Empty> : (
              <ul className="hits">
                {result.results.map((h, n) => (
                  <li key={n}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <button className="link-btn strong" onClick={() => setOpen(h.documentId)}>{h.title}</button>
                      <span className="small muted">{h.page ? `page ${h.page} · ` : ''}{h.section ? `${h.section} · ` : ''}{result.mode === 'keyword' ? 'keyword match' : `relevance ${h.score.toFixed(2)}`}</span>
                    </div>
                    <div className="small">{h.excerpt}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <div style={{ height: 16 }} />
      <Card
        title="Documents"
        action={
          <div className="row">
            <input className="input" placeholder="Filter by name…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter documents" style={{ width: 180 }} />
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option><option value="ready">Ready</option><option value="queued">Queued</option><option value="processing">Processing</option><option value="failed">Failed</option>
            </select>
            {isAdmin && <button className="btn sm" onClick={() => void act('Project documentation re-read', () => api.post('/knowledge/system/reindex'))} title="Re-read the project's own docs/ folder"><RefreshCw size={13} />Sync docs</button>}
          </div>
        }
        flush
      >
        {error ? <ErrorBox error={error} /> : !docs ? <Empty>Loading…</Empty> : !docs.length ? (
          <Empty>{filter || status ? 'No documents match these filters.' : 'No documents yet. Upload a maintenance manual, SOP or inspection report to get started.'}</Empty>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Document</th><th>Status</th><th>Visibility</th><th className="num">Chunks</th><th>Size</th><th>Added</th><th /></tr></thead>
            <tbody>
              {docs.map((d) => {
                const s = STATUS[d.status];
                return (
                  <tr key={d.id}>
                    <td style={{ maxWidth: 340 }}>
                      <button className="link-btn strong ellipsis" style={{ maxWidth: '100%' }} onClick={() => setOpen(d.id)}><FileText size={14} /> {d.title}</button>
                      <div className="small muted ellipsis">{d.originalName}{d.source === 'system' ? ' · project documentation' : d.ownerName ? ` · ${d.ownerName}` : ''}</div>
                      {d.status === 'failed' && d.error && <div className="small" style={{ color: 'var(--crit)' }}>{d.error}</div>}
                    </td>
                    <td><Badge tone={s.tone}>{d.status === 'processing' && <Loader2 size={11} className="spin" />}{s.label}</Badge></td>
                    <td><Badge tone={d.visibility === 'shared' ? 'accent' : ''}>{d.visibility === 'shared' ? <Globe size={11} /> : <Lock size={11} />}{d.visibility}</Badge></td>
                    <td className="num">{d.chunkCount}</td>
                    <td className="muted nowrap">{size(d.sizeBytes)}</td>
                    <td className="muted nowrap">{timeAgo(d.createdAt)}</td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      {d.status === 'failed' && d.canEdit && <button className="btn sm" onClick={() => void act('Retrying', () => api.post(`/knowledge/${d.id}/retry`))}><RefreshCw size={12} />Retry</button>}{' '}
                      {d.status === 'ready' && d.canEdit && <button className="btn sm ghost" title="Re-embed this document" aria-label={`Re-index ${d.title}`} onClick={() => void act('Re-indexing', () => api.post(`/knowledge/${d.id}/reindex`))}><RefreshCw size={13} /></button>}
                      <button className="btn sm ghost" aria-label={`Download ${d.title}`} onClick={() => downloadFile(`/knowledge/${d.id}/download`, d.originalName).catch((e: Error) => toast(e.message, 'error'))}><Download size={13} /></button>
                      {d.canEdit && <button className="btn sm ghost danger" aria-label={`Delete ${d.title}`} onClick={() => setConfirm(d)}><Trash2 size={13} /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>

      {open && <Details id={open} onClose={() => setOpen(null)} onChanged={refresh} />}
      {confirm && (
        <Modal
          title="Delete document?"
          onClose={() => setConfirm(null)}
          footer={<>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn danger" onClick={() => { const d = confirm; setConfirm(null); void act('Document deleted', () => api.del(`/knowledge/${d.id}`)); }}>Delete</button>
          </>}
        >
          <p style={{ margin: 0 }}><b>{confirm.title}</b> and all of its indexed passages will be removed. Past assistant answers that cited it keep their text but can no longer open the document.</p>
        </Modal>
      )}
    </>
  );
}

function Details({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: d, error } = useLive<KbDocument>(`/knowledge/${id}`, 4000);
  const [title, setTitle] = useState<string | null>(null);

  async function save(patch: object) {
    try { await api.patch(`/knowledge/${id}`, patch); toast('Saved'); onChanged(); setTitle(null); } catch (e) { toast((e as Error).message, 'error'); }
  }
  const { isAdmin } = useAuth();

  return (
    <Modal title="Document details" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {error ? <ErrorBox error={error} /> : !d ? <Empty>Loading…</Empty> : (
        <>
          {d.canEdit ? (
            <label className="field">Title
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input className="input" style={{ flex: 1 }} value={title ?? d.title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
                <button className="btn" disabled={title === null || !title.trim() || title === d.title} onClick={() => void save({ title })}>Save</button>
              </div>
            </label>
          ) : <h3>{d.title}</h3>}
          <dl className="kv">
            <dt>File</dt><dd className="ellipsis">{d.originalName}</dd>
            <dt>Status</dt><dd><Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge></dd>
            <dt>Size</dt><dd>{size(d.sizeBytes)}{d.pages ? ` · ${d.pages} pages` : ''}</dd>
            <dt>Indexed</dt><dd>{d.chunkCount} passages{d.embeddingModel ? ` · ${d.embeddingModel}` : ''}</dd>
            <dt>Owner</dt><dd>{d.source === 'system' ? 'Project documentation' : d.ownerName ?? 'unknown'}</dd>
            <dt>Visibility</dt>
            <dd>
              {d.canEdit && isAdmin ? (
                <select className="input" value={d.visibility} onChange={(e) => void save({ visibility: e.target.value })} aria-label="Visibility">
                  <option value="private">Private (owner and administrators)</option><option value="shared">Shared with everyone</option>
                </select>
              ) : d.visibility}
            </dd>
          </dl>
          {d.error && <div className="err">{d.error}</div>}
          {!!d.chunkPreview?.length && (
            <div>
              <div className="small muted" style={{ marginBottom: 6 }}>First indexed passages</div>
              <ul className="hits">
                {d.chunkPreview.map((c) => (
                  <li key={c.chunkIndex}><div className="small muted">#{c.chunkIndex + 1}{c.page ? ` · page ${c.page}` : ''}{c.section ? ` · ${c.section}` : ''}</div><div className="small">{c.preview}</div></li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
