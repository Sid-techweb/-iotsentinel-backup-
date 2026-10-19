import { config } from '../../config';
import { AIProviderError, ChatMessage, ChatOptions, LLMProvider, ProviderHealth } from './provider';

/**
 * A DETERMINISTIC TEST DOUBLE - not an AI model. It exists only so automated tests and CI (which have
 * no Ollama or GPU) can exercise the retrieval, citation and security code paths with reproducible output.
 * It is selected only by LLM_PROVIDER=deterministic-test and is refused when NODE_ENV=production.
 *
 *  - embeddings: hashed bag-of-words, so cosine similarity genuinely reflects word overlap;
 *  - chat: composes its reply from the first sentences of the labelled sources it was given and cites
 *    them, so a wrong citation or a leaked document is detectable.
 */
const STOP = new Set(['the', 'and', 'for', 'are', 'what', 'which', 'how', 'is', 'of', 'to', 'in', 'on', 'a', 'an', 'it', 'be', 'by', 'with', 'this', 'that', 'was', 'were', 'does', 'do', 'why', 'when']);

function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export function hashEmbed(text: string, dim: number): number[] {
  const v = Array.from({ length: dim }, () => 0);
  const counts = new Map<string, number>();
  for (const t of tokens(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [t, c] of counts) {
    const idx = fnv1a(t) % dim;
    const sign = fnv1a(t, 0x9747b28c) % 2 === 0 ? 1 : -1;
    v[idx] += sign * (1 + Math.log(c));
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  if (norm === 0) { v[0] = 1; return v; }
  return v.map((x) => x / norm);
}

export class DeterministicTestProvider implements LLMProvider {
  readonly name = 'deterministic-test';
  readonly chatModel = 'deterministic-test-chat';
  readonly embedModel = 'deterministic-test-embed';

  /** The messages of the most recent chat call, so tests can inspect exactly what a model would have received. */
  static lastMessages: ChatMessage[] = [];
  /** Set to make the next call fail, to test unavailable-model handling. */
  static failNext: AIProviderError | null = null;

  async health(): Promise<ProviderHealth> {
    return {
      ok: true, provider: this.name, version: 'test', installed: [this.chatModel, this.embedModel],
      chatModel: { name: this.chatModel, available: true }, embedModel: { name: this.embedModel, available: true, dimension: config.embedDim, dimensionOk: true },
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (DeterministicTestProvider.failNext) { const e = DeterministicTestProvider.failNext; DeterministicTestProvider.failNext = null; throw e; }
    return texts.map((t) => hashEmbed(t, config.embedDim));
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<string> {
    DeterministicTestProvider.lastMessages = messages;
    if (DeterministicTestProvider.failNext) { const e = DeterministicTestProvider.failNext; DeterministicTestProvider.failNext = null; throw e; }
    const all = messages.map((m) => m.content).join('\n');
    const found = [...all.matchAll(/\[([SD]\d+)\][^\n]*\n<<<BEGIN\n([\s\S]*?)\n<<<END/g)];
    const answer = found.length === 0
      ? 'I could not find that in the provided sources.'
      : 'Based on the sources: ' + found.slice(0, 3).map((m) => {
        const body = m[2].replace(/\s+/g, ' ').trim();
        const first = body.split(/(?<=[.!?])\s/)[0] ?? body;
        return `${first.length > 220 ? first.slice(0, 220) + '...' : first} [${m[1]}]`;
      }).join(' ');
    for (const word of answer.split(/(\s+)/)) {
      if (opts.signal?.aborted) return;
      if (word) yield word;
    }
  }
}
