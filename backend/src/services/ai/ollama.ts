import { config } from '../../config';
import { AIProviderError, ChatMessage, ChatOptions, LLMProvider, ModelStatus, ProviderHealth } from './provider';

const EMBED_BATCH = 16;
const HEALTH_TTL_MS = 8000;

const base = () => config.ollamaUrl;
const hasModel = (installed: string[], name: string) => installed.some((m) => m === name || m === `${name}:latest` || m.replace(/:latest$/, '') === name);

/** Ollama (https://ollama.com) running locally or in a container. */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly chatModel = config.llmModel;
  readonly embedModel = config.embedModel;
  private cache: { at: number; value: ProviderHealth } | null = null;

  /** fetch with a timeout, translating network failures into actionable errors. */
  private async request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const timeoutMs = init.timeoutMs ?? config.llmTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await fetch(`${base()}${path}`, { ...init, signal });
    } catch (e) {
      if (init.signal?.aborted) throw e; // the caller cancelled: not a provider failure
      if (timeout.aborted) throw new AIProviderError('timeout', `Ollama did not answer within ${Math.round(timeoutMs / 1000)} s (${path}). The model may still be loading - try again, or raise LLM_TIMEOUT_MS.`, 504);
      throw new AIProviderError('unavailable', `Cannot reach Ollama at ${base()}. Start it ("ollama serve") or set OLLAMA_URL. (${(e as Error).message})`);
    }
  }

  private async failure(res: Response, model: string): Promise<never> {
    let detail = '';
    try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* not JSON */ }
    if (res.status === 404 || /not found/i.test(detail)) {
      throw new AIProviderError('model_missing', `Model "${model}" is not installed in Ollama. Install it with: ollama pull ${model}`);
    }
    throw new AIProviderError('bad_response', `Ollama returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, 502);
  }

  async health(): Promise<ProviderHealth> {
    if (this.cache && Date.now() - this.cache.at < HEALTH_TTL_MS) return this.cache.value;
    const unavailable = (error: string, hint?: string): ProviderHealth => ({
      ok: false, provider: this.name, url: base(), installed: [], error, hint,
      chatModel: { name: this.chatModel, available: false }, embedModel: { name: this.embedModel, available: false },
    });
    let value: ProviderHealth;
    try {
      const tagsRes = await this.request('/api/tags', { timeoutMs: 3000 });
      if (!tagsRes.ok) throw new AIProviderError('bad_response', `Ollama returned HTTP ${tagsRes.status}`, 502);
      const installed = ((await tagsRes.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
      const version = await this.request('/api/version', { timeoutMs: 3000 }).then((r) => r.json() as Promise<{ version?: string }>).then((j) => j.version).catch(() => undefined);

      const chat: ModelStatus = { name: this.chatModel, available: hasModel(installed, this.chatModel) };
      const embed: ModelStatus = { name: this.embedModel, available: hasModel(installed, this.embedModel) };
      if (embed.available) {
        try {
          const [v] = await this.embedRaw(['dimension probe']);
          embed.dimension = v.length;
          embed.dimensionOk = v.length === config.embedDim;
        } catch { /* reported through `ok` below */ }
      }
      const problems: string[] = [];
      if (!chat.available) problems.push(`chat model "${this.chatModel}" is not installed (ollama pull ${this.chatModel})`);
      if (!embed.available) problems.push(`embedding model "${this.embedModel}" is not installed (ollama pull ${this.embedModel})`);
      else if (embed.dimensionOk === false) problems.push(`embedding model returns ${embed.dimension}-dimensional vectors but the database expects ${config.embedDim} (set EMBED_DIM / pick a matching model)`);
      value = {
        ok: problems.length === 0, provider: this.name, url: base(), version, installed, chatModel: chat, embedModel: embed,
        ...(problems.length ? { error: problems.join('; ') } : {}),
      };
    } catch (e) {
      value = unavailable((e as Error).message, 'Install Ollama from https://ollama.com, start it, and pull the configured models.');
    }
    this.cache = { at: Date.now(), value };
    return value;
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<string> {
    const res = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({
        model: this.chatModel,
        messages,
        stream: true,
        options: { temperature: opts.temperature ?? config.llmTemperature, num_ctx: config.llmNumCtx, ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}) },
      }),
    });
    if (!res.ok || !res.body) await this.failure(res, this.chatModel);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg: { message?: { content?: string }; error?: string; done?: boolean };
          try { msg = JSON.parse(line); } catch { throw new AIProviderError('bad_response', 'Ollama sent a malformed streaming line', 502); }
          if (msg.error) throw new AIProviderError('bad_response', `Ollama error: ${msg.error}`, 502);
          if (msg.message?.content) yield msg.message.content;
          if (msg.done) return;
        }
      }
    } catch (e) {
      if (e instanceof AIProviderError) throw e;
      if (opts.signal?.aborted) throw e;
      throw new AIProviderError('timeout', `The Ollama response stream ended unexpectedly (${(e as Error).message})`, 504);
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  private async embedRaw(inputs: string[]): Promise<number[][]> {
    const res = await this.request('/api/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      timeoutMs: config.embedTimeoutMs,
      body: JSON.stringify({ model: this.embedModel, input: inputs, truncate: true, keep_alive: /^\d+$/.test(config.embedKeepAlive) ? Number(config.embedKeepAlive) : config.embedKeepAlive }),
    });
    if (!res.ok) await this.failure(res, this.embedModel);
    const json = (await res.json()) as { embeddings?: number[][] };
    if (!json.embeddings || json.embeddings.length !== inputs.length) throw new AIProviderError('bad_response', 'Ollama returned a different number of embeddings than inputs', 502);
    return json.embeddings;
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    const prefix = kind === 'query' ? config.embedQueryPrefix : config.embedDocPrefix;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH).map((t) => prefix + t);
      for (const v of await this.embedRaw(batch)) {
        if (v.length !== config.embedDim) {
          throw new AIProviderError('dimension_mismatch',
            `Embedding model "${this.embedModel}" returned ${v.length}-dimensional vectors but the database column holds ${config.embedDim}. Choose a ${config.embedDim}-dimensional model or migrate the column and set EMBED_DIM.`, 500);
        }
        out.push(v);
      }
    }
    return out;
  }
}
