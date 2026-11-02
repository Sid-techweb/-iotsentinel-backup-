import { config } from '../../config';
import { AIProviderError, ChatMessage, ChatOptions, LLMProvider, ProviderHealth } from './provider';

const EMBED_BATCH = 16;
const HEALTH_TTL_MS = 15000;

const base = () => config.llmBaseUrl.replace(/\/+$/, '');
const NOT_CONNECTED = 'The AI model is not connected. Everything else in the platform keeps working. Set LLM_BASE_URL and LLM_API_KEY (or run Ollama) to enable the assistant.';

/**
 * Any OpenAI-compatible HTTP API (Google Gemini, Groq, OpenRouter, Together, a self-hosted vLLM, ...):
 *   POST {LLM_BASE_URL}/chat/completions   (streamed)   and   POST {LLM_BASE_URL}/embeddings
 * Used when the platform runs in the cloud, where a local Ollama is not reachable. The API key is read from the
 * environment only and is never logged or returned to the browser. NOTE: with this provider the text of questions and
 * of uploaded documents is sent to the API provider - unlike Ollama, which keeps everything on your own machine.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = 'openai-compatible';
  readonly chatModel = config.llmModel;
  readonly embedModel = config.embedModel;
  private cache: { at: number; value: ProviderHealth } | null = null;

  private async request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    if (!config.llmBaseUrl || !config.llmApiKey) throw new AIProviderError('unavailable', NOT_CONNECTED);
    const timeoutMs = init.timeoutMs ?? config.llmTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${base()}${path}`, { ...init, signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llmApiKey}`, ...(init.headers as Record<string, string> | undefined) } });
    } catch (e) {
      if (init.signal?.aborted) throw e;
      if (timeout.aborted) throw new AIProviderError('timeout', `The AI provider did not answer within ${Math.round(timeoutMs / 1000)} s.`, 504);
      throw new AIProviderError('unavailable', `The AI model is not connected (cannot reach ${base()}). Everything else in the platform keeps working. (${(e as Error).message})`);
    }
    if (res.ok) return res;
    let detail = '';
    try { const j = (await res.json()) as { error?: { message?: string } | string }; detail = typeof j.error === 'string' ? j.error : j.error?.message ?? ''; } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) throw new AIProviderError('unavailable', 'The AI provider rejected the API key (check LLM_API_KEY). Everything else keeps working.');
    if (res.status === 429) throw new AIProviderError('unavailable', 'The AI provider is busy (rate limit reached). Please try again in a minute.');
    if (res.status === 404) throw new AIProviderError('model_missing', `The AI provider does not know the model "${this.chatModel}" or "${this.embedModel}"${detail ? ` (${detail})` : ''}.`);
    throw new AIProviderError('bad_response', `The AI provider returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, 502);
  }

  async health(): Promise<ProviderHealth> {
    if (this.cache && Date.now() - this.cache.at < HEALTH_TTL_MS) return this.cache.value;
    const down = (error: string): ProviderHealth => ({
      ok: false, provider: this.name, url: config.llmBaseUrl || undefined, installed: [], error, hint: 'Set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL and EMBED_MODEL, or run Ollama.',
      chatModel: { name: this.chatModel, available: false }, embedModel: { name: this.embedModel, available: false },
    });
    let value: ProviderHealth;
    try {
      const [v] = await this.embedRaw(['dimension probe']);
      const ok = v.length === config.embedDim;
      value = {
        ok, provider: this.name, url: base(), installed: [], chatModel: { name: this.chatModel, available: true },
        embedModel: { name: this.embedModel, available: true, dimension: v.length, dimensionOk: ok },
        ...(ok ? {} : { error: `embedding model returns ${v.length}-dimensional vectors but the database expects ${config.embedDim}` }),
      };
    } catch (e) {
      value = down((e as Error).message);
    }
    this.cache = { at: Date.now(), value };
    return value;
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<string> {
    const res = await this.request('/chat/completions', {
      method: 'POST',
      signal: opts.signal,
      body: JSON.stringify({ model: this.chatModel, messages, stream: true, temperature: opts.temperature ?? config.llmTemperature, ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}) }),
    });
    if (!res.body) throw new AIProviderError('bad_response', 'The AI provider sent an empty response', 502);
    const reader = res.body.getReader();
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
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          let msg: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
          try { msg = JSON.parse(data); } catch { continue; }
          if (msg.error) throw new AIProviderError('bad_response', `The AI provider reported an error: ${msg.error.message ?? 'unknown'}`, 502);
          const piece = msg.choices?.[0]?.delta?.content;
          if (piece) yield piece;
        }
      }
    } catch (e) {
      if (e instanceof AIProviderError) throw e;
      if (opts.signal?.aborted) throw e;
      throw new AIProviderError('timeout', `The AI response stream ended unexpectedly (${(e as Error).message})`, 504);
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  private async embedRaw(inputs: string[]): Promise<number[][]> {
    const res = await this.request('/embeddings', {
      method: 'POST',
      timeoutMs: config.embedTimeoutMs,
      body: JSON.stringify({ model: this.embedModel, input: inputs, dimensions: config.embedDim }),
    });
    const json = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
    const rows = (json.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== inputs.length) throw new AIProviderError('bad_response', 'The AI provider returned a different number of embeddings than inputs', 502);
    return rows.map((r) => r.embedding);
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    const prefix = kind === 'query' ? config.embedQueryPrefix : config.embedDocPrefix;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      for (const v of await this.embedRaw(texts.slice(i, i + EMBED_BATCH).map((t) => prefix + t))) {
        if (v.length !== config.embedDim) {
          throw new AIProviderError('dimension_mismatch', `Embedding model "${this.embedModel}" returned ${v.length}-dimensional vectors but the database holds ${config.embedDim}.`, 500);
        }
        out.push(v);
      }
    }
    return out;
  }
}
