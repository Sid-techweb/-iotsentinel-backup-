import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth';
import { setToken, streamAnswer } from '../src/api';
import Markdown from '../src/components/Markdown';
import Assistant from '../src/pages/Assistant';
import { Toaster } from '../src/components/ui';
import KnowledgeBase from '../src/pages/KnowledgeBase';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** A server-sent-event body delivered in several chunks, like a real streamed answer. */
function sse(events: [string, unknown][], splitAt = 17) {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < text.length; i += splitAt) chunks.push(enc.encode(text.slice(i, i + splitAt)));
  return new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const SRC = { id: 'D1', type: 'database', title: 'Fleet status', excerpt: '4 devices online', cited: true, timestamp: '2026-10-15T10:00:00Z', tool: 'fleet_status' };
const DOC = { id: 'S1', type: 'document', title: 'Pump manual', excerpt: 'Flush every 500 hours', cited: true, document: { id: 'doc1', filename: 'pump.pdf', page: 3, section: null, origin: 'upload' } };

let calls: { method: string; url: string; body?: any }[] = [];
let answer: () => Response;

function mockApi(opts: { providerOk?: boolean; docs?: unknown[] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ method, url, body });
    if (url === '/api/auth/me') return json({ id: 'u1', email: 'a@b.c', name: 'Ada', role: 'viewer' });
    if (url === '/api/assistant/health') {
      return json({
        enabled: true, suggestions: ['How many devices are currently online?'], documents: { ready: 1, queued: 0, processing: 0, failed: 0 },
        provider: opts.providerOk === false ? { ok: false, error: 'connect ECONNREFUSED' } : { ok: true, chatModel: { name: 'm', available: true }, embedModel: { name: 'e', available: true } },
      });
    }
    if (url === '/api/devices') return json([{ id: 'dev1', assetNo: 7, name: 'Pump 7' }]);
    if (url === '/api/assistant/conversations' && method === 'GET') return json([]);
    if (url === '/api/assistant/conversations' && method === 'POST') return json({ id: 'c1', title: 'New chat', deviceId: null }, 201);
    if (url.endsWith('/messages') || url.endsWith('/retry')) return answer();
    if (url === '/api/knowledge/status') {
      return json({ enabled: true, provider: { ok: opts.providerOk !== false, error: 'down' }, documents: { total: 1, ready: 1, queued: 0, processing: 0, failed: 0 }, limits: { maxUploadMb: 1, chunkSize: 1000, chunkOverlap: 150, types: [] } });
    }
    if (url.startsWith('/api/knowledge') && method === 'GET') return json(opts.docs ?? []);
    if (url === '/api/knowledge' && method === 'POST') return json({ id: 'new' }, 202);
    if (url.startsWith('/api/knowledge/') && method === 'DELETE') return new Response(null, { status: 204 });
    return json({});
  }));
}

function renderPage(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><AuthProvider>{ui}<Toaster /></AuthProvider></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { calls = []; setToken('tok'); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe('Markdown renderer', () => {
  it('renders formatting, lists, code and citation markers', () => {
    render(<Markdown text={'Hello **bold** and `code`.\n\n- one\n- two [S1]\n\n```js\nconst x = 1;\n```'} sourceIds={['S1']} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Source S1' })).toBeInTheDocument();
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  it('never turns model output into HTML or script', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> <script>alert(1)</script> [link](javascript:alert(1))'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('flags a citation that does not match any source', () => {
    render(<Markdown text="Claimed [S9] and real [D1]" sourceIds={['D1']} />);
    expect(screen.getByTitle(/does not match any source/)).toHaveTextContent('S9');
    expect(screen.getByRole('button', { name: 'Source D1' })).toBeInTheDocument();
  });

  it('renders a table', () => {
    render(<Markdown text={'| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});

describe('streamAnswer', () => {
  it('parses events that arrive split across chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      ['meta', { sources: [SRC], toolCalls: [], kind: 'answer', truncated: false }],
      ['token', { text: 'Four ' }], ['token', { text: 'online' }],
      ['done', { messageId: 5, text: 'Four online [D1]', sources: [SRC], cited: ['D1'], invalidCitations: [], uncited: false, error: null }],
    ], 7)));
    const tokens: string[] = [];
    let done: any;
    await streamAnswer('/x', {}, { onToken: (t) => tokens.push(t), onDone: (d) => (done = d) });
    expect(tokens.join('')).toBe('Four online');
    expect(done.messageId).toBe(5);
  });

  it('throws the server message when the request is refused before streaming', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Ollama is not reachable' }, 503)));
    await expect(streamAnswer('/x', {}, {})).rejects.toThrow('Ollama is not reachable');
  });
});

describe('AI assistant page', () => {
  it('shows starter questions and streams an answer with its sources', async () => {
    mockApi();
    answer = () => sse([
      ['meta', { sources: [SRC, DOC], toolCalls: [{ tool: 'fleet_status', args: {}, ok: true, ms: 4 }], kind: 'answer', truncated: false }],
      ['token', { text: 'Four devices ' }], ['token', { text: 'are online [D1].' }],
      ['done', { messageId: 9, text: 'Four devices are online [D1].', sources: [SRC, { ...DOC, cited: false }], cited: ['D1'], invalidCitations: [], uncited: false, error: null }],
    ]);
    renderPage(<Assistant />);
    await userEvent.click(await screen.findByRole('button', { name: 'How many devices are currently online?' }));

    expect(await screen.findByText(/Four devices are online/)).toBeInTheDocument();
    expect(screen.getByText('Fleet status', { selector: '.tool' })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/assistant/conversations/c1/messages' && c.body.content === 'How many devices are currently online?')).toBe(true);

    await userEvent.click(await screen.findByRole('button', { name: /1 cited · 2 considered/ }));
    const cards = document.querySelectorAll('.source');
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText('Fleet status')).toBeInTheDocument();
    expect(screen.getByText('not cited')).toBeInTheDocument();
  });

  it('shows a clear error and offers retry when the model fails mid-answer', async () => {
    mockApi();
    answer = () => sse([
      ['meta', { sources: [], toolCalls: [], kind: 'answer', truncated: false }],
      ['token', { text: 'Partial' }],
      ['error', { message: 'The model timed out', partial: 'Partial' }],
      ['done', { messageId: 3, text: 'Partial', sources: [], cited: [], invalidCitations: [], uncited: false, error: 'The model timed out' }],
    ]);
    renderPage(<Assistant />);
    await userEvent.type(await screen.findByLabelText('Message'), 'status?{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('The model timed out');

    answer = () => sse([['done', { messageId: 4, text: 'All good', sources: [], cited: [], invalidCitations: [], uncited: false, error: null }]]);
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByText('All good')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/assistant/conversations/c1/retry')).toBe(true);
  });

  it('reports a refused request (model unavailable) without losing the question', async () => {
    mockApi();
    answer = () => json({ error: 'Ollama is not reachable' }, 503);
    renderPage(<Assistant />);
    await userEvent.type(await screen.findByLabelText('Message'), 'hello there{Enter}');
    expect(await screen.findByText('hello there', { selector: '.msg.user .bubble' })).toBeInTheDocument();
    expect(await screen.findByText('Ollama is not reachable')).toBeInTheDocument();
  });

  it('warns when the model service is down and disables sending', async () => {
    mockApi({ providerOk: false });
    renderPage(<Assistant />);
    expect(await screen.findByText(/model service is not reachable/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Message'), 'anything');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled());
  });

  it('does not send an empty message', async () => {
    mockApi();
    renderPage(<Assistant />);
    await userEvent.type(await screen.findByLabelText('Message'), '   {Enter}');
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  });
});

const doc = (over: object = {}) => ({
  id: 'd1', source: 'upload', title: 'Pump manual', originalName: 'pump.pdf', mime: 'application/pdf', sizeBytes: 2048, visibility: 'private', status: 'ready',
  error: null, attempts: 1, pages: 3, chunkCount: 6, embeddingModel: 'e', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ingestedAt: null, canEdit: true, ownerName: 'Ada', ...over,
});

describe('Knowledge Base page', () => {
  it('lists documents with their status and a retry action for failed ones', async () => {
    mockApi({ docs: [doc(), doc({ id: 'd2', title: 'Broken scan', status: 'failed', error: 'No text could be extracted' })] });
    renderPage(<KnowledgeBase />);
    expect(await screen.findByText('Pump manual')).toBeInTheDocument();
    expect(screen.getByText('No text could be extracted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    mockApi({ docs: [] });
    renderPage(<KnowledgeBase />);
    expect(await screen.findByText(/No documents yet/)).toBeInTheDocument();
  });

  it('rejects unsupported files before uploading anything', async () => {
    mockApi({ docs: [] });
    renderPage(<KnowledgeBase />);
    const input = await screen.findByLabelText('Choose documents to upload');
    await userEvent.upload(input, new File(['x'], 'virus.exe'), { applyAccept: false });
    expect(await screen.findByText(/only PDF, DOCX, TXT, MD and CSV/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/knowledge')).toBe(false);
  });

  it('uploads a supported file as multipart form data', async () => {
    mockApi({ docs: [] });
    renderPage(<KnowledgeBase />);
    const input = await screen.findByLabelText('Choose documents to upload');
    await userEvent.upload(input, new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/knowledge')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/knowledge')!;
    expect(post.body).toBeInstanceOf(FormData);
    expect((post.body as FormData).get('visibility')).toBe('private');
    expect(((post.body as FormData).get('file') as File).name).toBe('notes.txt');
  });

  it('asks for confirmation before deleting', async () => {
    mockApi({ docs: [doc()] });
    renderPage(<KnowledgeBase />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Pump manual' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/knowledge/d1')).toBe(true));
  });

  it('hides edit actions for documents the user cannot change', async () => {
    mockApi({ docs: [doc({ canEdit: false, source: 'system', title: 'REST API reference' })] });
    renderPage(<KnowledgeBase />);
    await screen.findByText('REST API reference');
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });
});
