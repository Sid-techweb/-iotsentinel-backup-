import { q, q1 } from '../../db';
import { HttpError } from '../../util';
import { deviceBriefs } from '../deviceQueries';
import { Source, ToolCall } from './rag';

export interface ChatMessageRow {
  id: number; conversationId: string; role: 'user' | 'assistant'; content: string;
  sources: Source[]; toolCalls: ToolCall[]; model: string | null; latencyMs: number | null; error: string | null; createdAt: string;
}

export const MAX_MESSAGES_PER_CONVERSATION = 200;

/** A conversation belongs to exactly one user. Others - administrators included - get a 404, never a peek. */
export async function getConversation(userId: string, id: string) {
  const row = await q1<any>('SELECT * FROM chat_conversations WHERE id=$1 AND user_id=$2', [id, userId]).catch(() => undefined);
  if (!row) throw new HttpError(404, 'Conversation not found');
  return (await withDeviceNames([row]))[0];
}

/** The device a conversation is focused on is kept in MongoDB; attach its name and number. */
async function withDeviceNames<T extends { deviceId?: string | null }>(rows: T[]): Promise<(T & { deviceName: string | null; assetNo: number | null })[]> {
  const map = await deviceBriefs(rows.map((r) => r.deviceId ?? ''));
  return rows.map((r) => ({ ...r, deviceName: r.deviceId ? map.get(r.deviceId)?.name ?? null : null, assetNo: r.deviceId ? map.get(r.deviceId)?.assetNo ?? null : null }));
}

export async function listConversations(userId: string) {
  const rows = await q(
    `SELECT c.id, c.title, c.device_id, c.created_at, c.updated_at,
            (SELECT count(*)::int FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT left(m.content, 120) FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS preview
       FROM chat_conversations c
      WHERE c.user_id=$1 ORDER BY c.updated_at DESC LIMIT 100`, [userId]);
  return withDeviceNames(rows);
}

export async function createConversation(userId: string, title?: string, deviceId?: string | null) {
  return q1<any>('INSERT INTO chat_conversations (user_id, title, device_id) VALUES ($1,$2,$3) RETURNING *', [userId, title?.trim() || 'New chat', deviceId ?? null]);
}

export async function updateConversation(userId: string, id: string, patch: { title?: string; deviceId?: string | null }) {
  await getConversation(userId, id);
  await q(
    `UPDATE chat_conversations SET title = COALESCE($3, title), device_id = CASE WHEN $4::boolean THEN $5 ELSE device_id END, updated_at = now() WHERE id=$1 AND user_id=$2`,
    [id, userId, patch.title?.trim() || null, patch.deviceId !== undefined, patch.deviceId ?? null]);
  return getConversation(userId, id);
}

export async function deleteConversation(userId: string, id: string) {
  await getConversation(userId, id);
  await q('DELETE FROM chat_conversations WHERE id=$1 AND user_id=$2', [id, userId]);
}

export async function messagesOf(conversationId: string): Promise<ChatMessageRow[]> {
  return q<ChatMessageRow>('SELECT * FROM chat_messages WHERE conversation_id=$1 ORDER BY id', [conversationId]);
}

export async function appendMessage(
  conversationId: string,
  m: { role: 'user' | 'assistant'; content: string; sources?: Source[]; toolCalls?: ToolCall[]; model?: string | null; latencyMs?: number | null; error?: string | null },
) {
  const row = await q1<ChatMessageRow>(
    `INSERT INTO chat_messages (conversation_id, role, content, sources, tool_calls, model, latency_ms, error)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8) RETURNING *`,
    [conversationId, m.role, m.content, JSON.stringify(m.sources ?? []), JSON.stringify(m.toolCalls ?? []), m.model ?? null, m.latencyMs ?? null, m.error ?? null]);
  await q('UPDATE chat_conversations SET updated_at = now() WHERE id=$1', [conversationId]);
  return row!;
}

/** The first question names the chat. */
export async function autoTitle(conversationId: string, firstQuestion: string) {
  const title = firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 60);
  await q(`UPDATE chat_conversations SET title=$2 WHERE id=$1 AND title='New chat'`, [conversationId, title + (firstQuestion.length > 60 ? '…' : '')]);
}

/** Markdown transcript, including the sources behind every answer. */
export function toMarkdown(conv: { title: string; createdAt: string }, messages: ChatMessageRow[]): string {
  const out = [`# ${conv.title}`, '', `_Exported from IoT Sentinel AI Maintenance Assistant on ${new Date().toISOString()}_`, ''];
  for (const m of messages) {
    out.push(m.role === 'user' ? '## You' : '## Assistant', '', m.content || (m.error ? `_(no answer: ${m.error})_` : ''), '');
    const cited = (m.sources ?? []).filter((s) => s.cited);
    if (cited.length) {
      out.push('**Sources**', '');
      for (const s of cited) {
        out.push(s.type === 'document'
          ? `- [${s.id}] ${s.title} (${s.document?.filename}${s.document?.page ? `, page ${s.document.page}` : ''})`
          : `- [${s.id}] Live data: ${s.title}${s.timestamp ? ` (as of ${s.timestamp})` : ''}${s.simulated ? ' - includes simulated devices' : ''}`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}
