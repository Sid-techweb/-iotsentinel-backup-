import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { features, q } from '../db';
import { col } from '../mongo';
import { rateLimit } from '../middleware/rateLimit';
import { redis } from '../redis';
import { AIProviderError, getProvider } from '../services/ai/provider';
import { appendMessage, autoTitle, ChatMessageRow, createConversation, deleteConversation, getConversation, listConversations, MAX_MESSAGES_PER_CONVERSATION, messagesOf, toMarkdown, updateConversation } from '../services/ai/chatStore';
import { finalizeAnswer, NOT_IN_FILE_TEXT, prepareTurn, Source } from '../services/ai/rag';
import { audit, ctxOf } from '../services/audit';
import { asyncH, HttpError } from '../util';

export const assistantRouter = Router();

assistantRouter.use((_req, _res, next) => {
  if (!features.knowledgeBase) return next(new HttpError(503, 'The AI assistant is unavailable: the database has no pgvector extension. Use the provided PostgreSQL image (see docs/DEPLOYMENT_GUIDE.md).'));
  next();
});

const me = (req: Request) => req.user!.id;
const viewer = (req: Request) => ({ id: req.user!.id, role: req.user!.role });

const SUGGESTIONS = [
  'How many devices are currently online?',
  'Which devices need maintenance attention?',
  'Show the five devices with the highest current risk',
  'What alerts were generated today?',
  'Which machine has the highest vibration?',
  'Which machine types have the most threshold breaches?',
  'What does the documentation say about retraining the model?',
];

/** Is the model provider reachable and are its models installed? Also the starter questions. */
assistantRouter.get('/health', asyncH(async (req, res) => {
  const [provider, docs, top] = await Promise.all([
    getProvider().health().catch((e: Error) => ({ ok: false, provider: config.llmProvider, error: e.message })),
    q<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM kb_documents GROUP BY status'),
    col('devices').find({ active: { $ne: false }, status: { $ne: 'offline' } }, { projection: { assetNo: 1 } }).sort({ assetNo: 1 }).limit(1).toArray(),
  ]);
  const by = Object.fromEntries(docs.map((d) => [d.status, d.n]));
  res.json({
    enabled: true,
    provider,
    documents: { ready: by.ready ?? 0, queued: by.queued ?? 0, processing: by.processing ?? 0, failed: by.failed ?? 0 },
    suggestions: top[0] ? [...SUGGESTIONS, `Why is device ${top[0].assetNo} showing its current risk level?`] : SUGGESTIONS,
    user: { id: me(req) },
  });
}));

assistantRouter.get('/conversations', asyncH(async (req, res) => res.json(await listConversations(me(req)))));

assistantRouter.post('/conversations', asyncH(async (req, res) => {
  const b = z.object({ title: z.string().trim().max(120).optional(), deviceId: z.string().uuid().nullable().optional() }).parse(req.body ?? {});
  const conv = await createConversation(me(req), b.title, b.deviceId);
  res.status(201).json(conv);
}));

assistantRouter.get('/conversations/:id', asyncH(async (req, res) => {
  const conv = await getConversation(me(req), String(req.params.id));
  res.json({ ...conv, messages: await messagesOf(conv.id) });
}));

assistantRouter.patch('/conversations/:id', asyncH(async (req, res) => {
  const b = z.object({ title: z.string().trim().min(1).max(120).optional(), deviceId: z.string().uuid().nullable().optional() }).parse(req.body);
  res.json(await updateConversation(me(req), String(req.params.id), b));
}));

assistantRouter.delete('/conversations/:id', asyncH(async (req, res) => {
  await deleteConversation(me(req), String(req.params.id));
  audit(ctxOf(req), 'assistant.conversation_delete', 'conversation', req.params.id);
  res.status(204).end();
}));

assistantRouter.get('/conversations/:id/export', asyncH(async (req, res) => {
  const conv = await getConversation(me(req), String(req.params.id));
  const messages = await messagesOf(conv.id);
  if (req.query.format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="conversation-${conv.id}.json"`);
    return void res.json({ conversation: conv, messages });
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="conversation-${conv.id}.md"`);
  res.send(toMarkdown(conv, messages));
}));

/* ------------------------------------------------------------------ one question -> one streamed answer */

const send = (res: Response, event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

async function runTurn(req: Request, res: Response, convId: string, question: string) {
  const conv = await getConversation(me(req), convId);
  const history = (await messagesOf(conv.id)).filter((m: ChatMessageRow) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
  history.pop(); // the question just asked is added separately by the prompt builder

  // 1. understand the question, read live data, retrieve documents (no model call yet)
  const started = Date.now();
  let prepared;
  try {
    prepared = await prepareTurn(viewer(req), question, history, conv.deviceId);
  } catch (e) {
    const err = e instanceof AIProviderError ? e : null;
    const message = err ? err.message : `Could not prepare the answer: ${(e as Error).message}`;
    await appendMessage(conv.id, { role: 'assistant', content: '', error: message });
    return void res.status(err?.status ?? 500).json({ error: message, code: err?.code ?? 'internal' });
  }
  for (const c of prepared.toolCalls) audit(ctxOf(req), 'assistant.tool', 'conversation', conv.id, { tool: c.tool, args: c.args, ok: c.ok, ms: c.ms, error: c.error });

  // 2. from here on the answer is streamed
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  send(res, 'meta', { sources: prepared.sources, toolCalls: prepared.toolCalls, kind: prepared.kind, truncated: prepared.truncated });

  let text = '';
  let error: string | null = null;
  let model: string | null = null;
  try {
    if (prepared.fixedText !== undefined) {
      text = prepared.fixedText;
      send(res, 'token', { text });
    } else {
      const provider = getProvider();
      model = provider.chatModel;
      for await (const token of provider.chat(prepared.messages, { signal: controller.signal })) {
        text += token;
        send(res, 'token', { text: token });
      }
    }
  } catch (e) {
    error = controller.signal.aborted ? 'Stopped before the answer was complete' : e instanceof AIProviderError ? e.message : `The model failed: ${(e as Error).message}`;
  }

  // a small model can occasionally return nothing at all: say so, so the user can retry instead of waiting
  if (!error && prepared.kind === 'answer' && !text.trim()) error = 'The model returned an empty answer. Try again, or rephrase the question.';

  let final = prepared.kind === 'answer' ? finalizeAnswer(text, prepared.sources) : { text, cited: [] as string[], invalid: [] as string[], uncited: false, sources: prepared.sources as Source[] };
  // a question about the user's own file is only answered when the answer cites that file; otherwise say so plainly
  if (prepared.docOnly && !error && prepared.kind === 'answer' && (final.cited.length === 0 || /^\W*not in the file/i.test(final.text))) {
    final = { text: NOT_IN_FILE_TEXT, cited: [], invalid: [], uncited: false, sources: final.sources.map((s) => ({ ...s, cited: false })) };
  }
  const saved = await appendMessage(conv.id, {
    role: 'assistant', content: final.text, sources: final.sources, toolCalls: prepared.toolCalls, model, latencyMs: Date.now() - started, error,
  });
  audit(ctxOf(req), 'assistant.message', 'conversation', conv.id, {
    kind: prepared.kind, sources: final.sources.length, cited: final.cited.length, invalidCitations: final.invalid.length, tools: prepared.toolCalls.map((c) => c.tool), ms: Date.now() - started, error: error ?? undefined,
  });
  if (error) send(res, 'error', { message: error, messageId: saved.id, partial: final.text });
  send(res, 'done', { messageId: saved.id, text: final.text, sources: final.sources, cited: final.cited, invalidCitations: final.invalid, uncited: final.uncited, error });
  res.end();
}

const turnLimiter = rateLimit({ name: 'assistant', max: config.assistantMessagesPerMinute, by: (r) => r.user?.id ?? r.ip ?? 'anon' });

/** One generation per conversation at a time (a lock in Redis; it expires by itself if the server dies mid-answer). */
async function withLock(convId: string, fn: () => Promise<void>) {
  const key = `chat:lock:${convId}`;
  const got = await redis.set(key, '1', 'EX', 300, 'NX');
  if (!got) throw new HttpError(409, 'An answer is already being generated for this conversation.');
  try { await fn(); } finally { await redis.del(key); }
}

assistantRouter.post('/conversations/:id/messages', turnLimiter, asyncH(async (req, res) => {
  const { content } = z.object({ content: z.string().trim().min(1, 'Type a question').max(4000) }).parse(req.body);
  const conv = await getConversation(me(req), String(req.params.id));
  if ((await messagesOf(conv.id)).length >= MAX_MESSAGES_PER_CONVERSATION) throw new HttpError(409, 'This conversation is full - start a new chat.');
  await withLock(conv.id, async () => {
    await appendMessage(conv.id, { role: 'user', content });
    await autoTitle(conv.id, content);
    await runTurn(req, res, conv.id, content);
  });
}));

/** Answer the last question again (after an error, or for a fresh attempt). */
assistantRouter.post('/conversations/:id/retry', turnLimiter, asyncH(async (req, res) => {
  const conv = await getConversation(me(req), String(req.params.id));
  const messages = await messagesOf(conv.id);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) throw new HttpError(409, 'There is no question to answer again.');
  await withLock(conv.id, async () => {
    await q('DELETE FROM chat_messages WHERE conversation_id=$1 AND id > $2', [conv.id, lastUser.id]); // drop the failed / old answer
    await runTurn(req, res, conv.id, lastUser.content);
  });
}));
