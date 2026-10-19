import { config } from '../../config';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export type AIErrorCode = 'unavailable' | 'model_missing' | 'timeout' | 'bad_response' | 'dimension_mismatch' | 'disabled';

/**
 * Every failure of the language-model backend is reported with a stable code and a message that
 * says what to do - the application never replaces a failed model call with an invented answer.
 */
export class AIProviderError extends Error {
  constructor(public code: AIErrorCode, message: string, public status = 503) {
    super(message);
    this.name = 'AIProviderError';
  }
}

export interface ModelStatus { name: string; available: boolean; dimension?: number; dimensionOk?: boolean }

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  url?: string;
  version?: string;
  chatModel: ModelStatus;
  embedModel: ModelStatus;
  installed: string[];
  error?: string;
  hint?: string;
}

export interface ChatOptions { signal?: AbortSignal; temperature?: number; maxTokens?: number }

/** What the rest of the application needs from a model provider. Swap implementations without touching callers. */
export interface LLMProvider {
  readonly name: string;
  readonly chatModel: string;
  readonly embedModel: string;
  health(): Promise<ProviderHealth>;
  /** Stream the model's answer token by token. */
  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<string>;
  /** Embed texts. `kind` lets a provider apply the right task prefix for documents vs queries. */
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

let instance: LLMProvider | null = null;

/** The configured provider (created lazily, once). Imports are lazy so the test provider never loads in production. */
export function getProvider(): LLMProvider {
  if (instance) return instance;
  if (config.llmProvider === 'ollama') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OllamaProvider } = require('./ollama') as typeof import('./ollama');
    instance = new OllamaProvider();
  } else if (config.llmProvider === 'deterministic-test') {
    if (process.env.NODE_ENV === 'production') throw new AIProviderError('disabled', 'LLM_PROVIDER=deterministic-test is for automated tests only and is refused in production', 500);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DeterministicTestProvider } = require('./testProvider') as typeof import('./testProvider');
    instance = new DeterministicTestProvider();
  } else {
    throw new AIProviderError('disabled', `Unknown LLM_PROVIDER "${config.llmProvider}". Supported: ollama`, 500);
  }
  return instance;
}

/** Replace the provider (used by tests to inject doubles). */
export function setProviderForTests(p: LLMProvider | null) {
  instance = p;
}
