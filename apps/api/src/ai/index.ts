/**
 * AI provider factory. The active provider is chosen purely by config:
 *
 *   AI_PROVIDER=rules   → deterministic offline assistant (default; no key)
 *   AI_PROVIDER=openai  → OpenAI-compatible API (needs OPENAI_API_KEY)
 *
 * Unknown/unavailable configurations fall back to the rules provider so the
 * assistant never breaks the product, and the fallback is visible in API
 * responses (`provider: 'rules'`), never hidden from the user.
 */
import type { Config } from '../config.js';
import type { AiProvider } from './types.js';
import { RulesProvider } from './rules.js';
import { OpenAiProvider } from './openai.js';

export type { AiProvider } from './types.js';

export function createAiProvider(config: Config): AiProvider {
  if (config.AI_PROVIDER === 'openai' && config.OPENAI_API_KEY) {
    return new OpenAiProvider({
      apiKey: config.OPENAI_API_KEY,
      baseUrl: config.OPENAI_BASE_URL,
      model: config.AI_MODEL,
    });
  }
  return new RulesProvider();
}
