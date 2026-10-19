import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, Check, ChevronDown, Copy, Database, Download, FileText, Loader2, Menu, MessageSquarePlus, Pencil, RotateCw, Send, Sparkles, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, AssistantHealth, ChatMsg, ChatSource, Conversation, Device, downloadFile, streamAnswer, useLive } from '../api';
import Markdown from '../components/Markdown';
import { Modal, toast } from '../components/ui';
import { timeAgo } from '../format';

const TOOL_LABEL: Record<string, string> = {
  fleet_status: 'Fleet status', device_profile: 'Device profile', telemetry_history: 'Telemetry history', top_risk: 'Highest-risk devices',
  explain_prediction: 'Prediction explanation', anomaly_history: 'Prediction history', maintenance_history: 'Maintenance history',
  maintenance_attention: 'Maintenance attention', highest_metric: 'Highest reading', alerts_summary: 'Alerts summary',
  breaches_by_type: 'Breaches by machine type', model_info: 'Model information',
};

/** The AI Maintenance Assistant: ask about the fleet and the knowledge base, with every claim traceable to a source. */
export default function Assistant() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: health } = useLive<AssistantHealth>('/assistant/health', 20000);
  const { data: devices } = useLive<Device[]>('/devices', false);
  const { data: convs } = useLive<Conversation[]>('/assistant/conversations', false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [title, setTitle] = useState('');
  const [deviceId, setDeviceId] = useState<string>('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [rename, setRename] = useState<Conversation | null>(null);
  const [remove, setRemove] = useState<Conversation | null>(null);
  const [focusSource, setFocusSource] = useState<{ msg: ChatMsg['id']; id: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const refreshList = useCallback(() => qc.invalidateQueries({ queryKey: ['/assistant/conversations'] }), [qc]);

  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const openConversation = useCallback(async (id: string) => {
    abort.current?.abort();
    setLoading(true);
    setDrawer(false);
    try {
      const c = await api.get<Conversation>(`/assistant/conversations/${id}`);
      setActiveId(c.id);
      setTitle(c.title);
      setDeviceId(c.deviceId ?? '');
      setMessages(c.messages ?? []);
      stick.current = true;
    } catch (e) { toast((e as Error).message, 'error'); } finally { setLoading(false); }
  }, []);

  const newChat = useCallback(() => {
    abort.current?.abort();
    setActiveId(null); setMessages([]); setTitle(''); setText(''); setDrawer(false);
    setDeviceId(params.get('device') ?? '');
    box.current?.focus();
  }, [params]);

  // arriving from a device page: ?device=<id>&q=<question> starts a chat about that device
  useEffect(() => {
    const d = params.get('device'); const q = params.get('q');
    if (d) setDeviceId(d);
    if (q) setText(q);
    if (d || q) setParams({}, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureConversation(): Promise<string> {
    if (activeId) return activeId;
    const c = await api.post<Conversation>('/assistant/conversations', { deviceId: deviceId || null });
    setActiveId(c.id);
    return c.id;
  }

  /** Stream one answer into the (already appended) pending assistant message. */
  async function run(path: string, body: unknown, pendingId: string) {
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    const patch = (fn: (m: ChatMsg) => ChatMsg) => setMessages((all) => all.map((m) => (m.id === pendingId ? fn(m) : m)));
    try {
      await streamAnswer(path, body, {
        onMeta: (m) => patch((x) => ({ ...x, sources: m.sources, toolCalls: m.toolCalls })),
        onToken: (t) => patch((x) => ({ ...x, content: x.content + t })),
        onError: (message) => patch((x) => ({ ...x, error: message })),
        onDone: (d) => patch((x) => ({ ...x, id: d.messageId, content: d.text, sources: d.sources, error: d.error, pending: false })),
      }, ctl.signal);
    } catch (e) {
      if (ctl.signal.aborted) patch((x) => ({ ...x, pending: false, error: x.content ? 'Stopped' : 'Stopped before an answer was written' }));
      else patch((x) => ({ ...x, pending: false, error: (e as Error).message }));
    } finally {
      patch((x) => ({ ...x, pending: false }));
      setBusy(false);
      abort.current = null;
      void refreshList();
    }
  }

  const blank = (role: ChatMsg['role'], content: string, pending = false): ChatMsg => ({
    id: `tmp-${Date.now()}-${role}`, role, content, sources: [], toolCalls: [], model: null, latencyMs: null, error: null, createdAt: new Date().toISOString(), pending,
  });

  async function send(question = text) {
    const content = question.trim();
    if (!content || busy) return;
    let id: string;
    try { id = await ensureConversation(); } catch (e) { toast((e as Error).message, 'error'); return; }
    const reply = blank('assistant', '', true);
    setText('');
    stick.current = true;
    setMessages((m) => [...m, blank('user', content), reply]);
    if (!title) setTitle(content.slice(0, 60));
    await run(`/assistant/conversations/${id}/messages`, { content }, String(reply.id));
  }

  async function retry() {
    if (!activeId || busy) return;
    const reply = blank('assistant', '', true);
    setMessages((m) => {
      const lastUser = m.map((x) => x.role).lastIndexOf('user');
      return [...m.slice(0, lastUser + 1), reply];
    });
    stick.current = true;
    await run(`/assistant/conversations/${activeId}/retry`, {}, String(reply.id));
  }

  async function applyDevice(id: string) {
    setDeviceId(id);
    if (activeId) {
      try { await api.patch(`/assistant/conversations/${activeId}`, { deviceId: id || null }); void refreshList(); } catch (e) { toast((e as Error).message, 'error'); }
    }
  }

  async function doRename(c: Conversation, name: string) {
    try { await api.patch(`/assistant/conversations/${c.id}`, { title: name }); if (c.id === activeId) setTitle(name); void refreshList(); setRename(null); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  async function doDelete(c: Conversation) {
    try { await api.del(`/assistant/conversations/${c.id}`); if (c.id === activeId) newChat(); void refreshList(); setRemove(null); toast('Chat deleted'); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  const exportChat = (format: 'md' | 'json') =>
    activeId && downloadFile(`/assistant/conversations/${activeId}/export${format === 'json' ? '?format=json' : ''}`, `${(title || 'chat').replace(/[^\w-]+/g, '_')}.${format}`).catch((e: Error) => toast(e.message, 'error'));

  const provider = health?.provider;
  const offline = !!provider && !provider.ok;
  const missingChat = provider?.ok && provider.chatModel && !provider.chatModel.available;
  const missingEmbed = provider?.ok && provider.embedModel && !provider.embedModel.available;
  const device = useMemo(() => devices?.find((d) => d.id === deviceId), [devices, deviceId]);
  const lastIsAssistant = messages.at(-1)?.role === 'assistant';

  return (
    <div className="chat-shell">
      <aside className={`chat-side ${drawer ? 'open' : ''}`} aria-label="Conversations">
        <div className="chat-side-head">
          <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={newChat}><MessageSquarePlus size={15} />New chat</button>
          <button className="btn ghost chat-close" onClick={() => setDrawer(false)} aria-label="Close conversations"><X size={16} /></button>
        </div>
        <ul className="chat-list">
          {convs?.map((c) => (
            <li key={c.id} className={c.id === activeId ? 'on' : ''}>
              <button className="chat-item" onClick={() => void openConversation(c.id)}>
                <span className="strong ellipsis">{c.title}</span>
                <span className="small muted ellipsis">{c.deviceName ? `${c.deviceName} · ` : ''}{timeAgo(c.updatedAt)}</span>
              </button>
              <button className="btn sm ghost" aria-label={`Rename ${c.title}`} onClick={() => setRename(c)}><Pencil size={12} /></button>
              <button className="btn sm ghost danger" aria-label={`Delete ${c.title}`} onClick={() => setRemove(c)}><Trash2 size={12} /></button>
            </li>
          ))}
          {convs && !convs.length && <li className="empty small">No chats yet</li>}
        </ul>
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <button className="btn ghost chat-menu" onClick={() => setDrawer(true)} aria-label="Open conversations"><Menu size={17} /></button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 className="ellipsis">{title || 'AI Maintenance Assistant'}</h1>
            <div className="small muted">Answers come only from live platform data and your documents - always with sources.</div>
          </div>
          <select className="input" value={deviceId} onChange={(e) => void applyDevice(e.target.value)} aria-label="Device context" title="Focus the assistant on one device">
            <option value="">All devices</option>
            {devices?.map((d) => <option key={d.id} value={d.id}>#{d.assetNo} {d.name}</option>)}
          </select>
          {activeId && messages.length > 0 && (
            <div className="menu-wrap">
              <button className="btn" onClick={() => exportChat('md')}><Download size={14} />Export</button>
            </div>
          )}
        </header>

        {(offline || missingChat || missingEmbed) && (
          <div className="notice warn" role="alert" style={{ margin: '10px 16px 0' }}>
            <AlertTriangle size={16} />
            <div>
              {offline ? <><b>The AI model service is not reachable.</b> Questions can't be answered until Ollama is running. <span className="small">{provider?.error}</span></>
                : missingChat ? <><b>Chat model {provider?.chatModel?.name} is not installed.</b> Run <code>ollama pull {provider?.chatModel?.name}</code>.</>
                : <><b>Embedding model {provider?.embedModel?.name} is not installed.</b> Run <code>ollama pull {provider?.embedModel?.name}</code>.</>}
            </div>
          </div>
        )}

        <div className="chat-scroll" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {loading ? <div className="empty"><Loader2 className="spin" size={18} /> Loading chat…</div> : messages.length === 0 ? (
            <div className="chat-welcome">
              <div className="brand-mark"><Sparkles size={18} /></div>
              <h2>How can I help with your fleet?</h2>
              <p className="muted">I can read live device data, prediction explanations and the documents in the <Link to="/knowledge" className="link">Knowledge Base</Link>. I never change anything.</p>
              {health && health.documents.ready === 0 && (
                <p className="small muted"><BookOpen size={13} /> No documents are indexed yet. <Link to="/knowledge" className="link">Upload a manual</Link> to ask about procedures.</p>
              )}
              <div className="suggest">
                {(health?.suggestions ?? []).map((s) => <button key={s} className="chip" onClick={() => void send(s)} disabled={busy || offline}>{s}</button>)}
              </div>
            </div>
          ) : (
            <div className="chat-thread">
              {messages.map((m, n) => (
                <Message
                  key={m.id}
                  m={m}
                  focus={focusSource?.msg === m.id ? focusSource.id : null}
                  onCite={(id) => setFocusSource({ msg: m.id, id })}
                  canRetry={n === messages.length - 1 && m.role === 'assistant' && !busy}
                  onRetry={() => void retry()}
                />
              ))}
              <div ref={end} />
            </div>
          )}
        </div>

        <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          {device && <div className="small muted" style={{ marginBottom: 4 }}>Context: <b>#{device.assetNo} {device.name}</b> - say "this device" to refer to it.</div>}
          <div className="compose-row">
            <textarea
              ref={box} className="input" rows={1} value={text} maxLength={4000} placeholder="Ask about devices, alerts, risk, maintenance or your documents…"
              aria-label="Message"
              onChange={(e) => { setText(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 160) + 'px'; }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            />
            {busy ? (
              <button type="button" className="btn" onClick={() => abort.current?.abort()} aria-label="Stop generating"><Square size={14} />Stop</button>
            ) : (
              <button type="submit" className="btn primary" disabled={!text.trim() || offline} aria-label="Send message"><Send size={15} />Send</button>
            )}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>Enter to send · Shift+Enter for a new line · Answers can be wrong - check the cited sources.{lastIsAssistant ? '' : ''}</div>
        </form>
      </section>

      {rename && <RenameModal c={rename} onClose={() => setRename(null)} onSave={(name) => void doRename(rename, name)} />}
      {remove && (
        <Modal title="Delete this chat?" onClose={() => setRemove(null)} footer={<><button className="btn" onClick={() => setRemove(null)}>Cancel</button><button className="btn danger" onClick={() => void doDelete(remove)}>Delete</button></>}>
          <p style={{ margin: 0 }}><b>{remove.title}</b> and its messages will be permanently deleted.</p>
        </Modal>
      )}
    </div>
  );
}

function RenameModal({ c, onClose, onSave }: { c: Conversation; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(c.title);
  return (
    <Modal title="Rename chat" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>Save</button></>}>
      <label className="field">Title<input className="input" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim())} /></label>
    </Modal>
  );
}

function Message({ m, focus, onCite, canRetry, onRetry }: { m: ChatMsg; focus: string | null; onCite: (id: string) => void; canRetry: boolean; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const cited = m.sources.filter((s) => s.cited);
  const others = m.sources.filter((s) => !s.cited);

  useEffect(() => { if (focus) setShowSources(true); }, [focus]);

  if (m.role === 'user') return <div className="msg user"><div className="bubble">{m.content}</div></div>;

  const copy = async () => { try { await navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };

  return (
    <div className="msg assistant">
      <div className="avatar-ai" aria-hidden><Sparkles size={14} /></div>
      <div className="bubble" aria-live={m.pending ? 'polite' : undefined}>
        {m.toolCalls.length > 0 && (
          <div className="tools" aria-label="Live data used">
            <Database size={12} />
            {m.toolCalls.map((t, i) => <span key={i} className={`tool ${t.ok ? '' : 'bad'}`} title={t.ok ? `${t.ms} ms` : t.error}>{TOOL_LABEL[t.tool] ?? t.tool}</span>)}
          </div>
        )}
        {m.content ? <Markdown text={m.content} onCite={onCite} sourceIds={m.sources.map((s) => s.id)} /> : m.pending ? <span className="typing"><i /><i /><i /><span className="sr-only">Writing an answer</span></span> : null}
        {m.pending && m.content && <span className="caret" aria-hidden />}
        {m.error && (
          <div className="msg-error" role="alert"><AlertTriangle size={14} /> {m.error}</div>
        )}
        {!m.pending && (
          <div className="msg-actions">
            {m.content && <button className="btn sm ghost" onClick={copy} aria-label="Copy answer">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}</button>}
            {canRetry && <button className="btn sm ghost" onClick={onRetry}><RotateCw size={13} />{m.error ? 'Retry' : 'Regenerate'}</button>}
            {m.sources.length > 0 && (
              <button className="btn sm ghost" onClick={() => setShowSources((s) => !s)} aria-expanded={showSources}>
                <ChevronDown size={13} style={{ transform: showSources ? 'rotate(180deg)' : undefined }} />{cited.length} cited · {m.sources.length} considered
              </button>
            )}
            {m.model && <span className="small muted">{m.model}{m.latencyMs ? ` · ${(m.latencyMs / 1000).toFixed(1)}s` : ''}</span>}
          </div>
        )}
        {showSources && m.sources.length > 0 && (
          <div className="sources">
            {[...cited, ...others].map((s) => <SourceCard key={s.id} s={s} highlight={focus === s.id} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function SourceCard({ s, highlight }: { s: ChatSource; highlight: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (highlight) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [highlight]);
  return (
    <div ref={ref} className={`source ${s.cited ? 'cited' : ''} ${highlight ? 'hl' : ''}`}>
      <div className="source-head">
        <span className="cite">{s.id}</span>
        {s.type === 'document' ? <FileText size={13} /> : <Database size={13} />}
        <span className="strong ellipsis">{s.title}</span>
        {!s.cited && <span className="small muted">not cited</span>}
      </div>
      {s.type === 'document' && s.document && (
        <div className="small muted">
          {s.document.origin === 'system' ? 'Project documentation' : s.document.filename}{s.document.page ? ` · page ${s.document.page}` : ''}{s.document.section ? ` · ${s.document.section}` : ''}
        </div>
      )}
      {s.type === 'database' && (
        <div className="small muted">
          Live data{s.timestamp ? ` as of ${new Date(s.timestamp).toLocaleString()}` : ''}{s.simulated ? ' · includes simulated devices' : ''}
          {s.device ? <> · <Link to={`/devices/${s.device.id}`} className="link">#{s.device.assetNo} {s.device.name}</Link></> : null}
        </div>
      )}
      <div className="small source-excerpt">{s.excerpt}</div>
    </div>
  );
}
