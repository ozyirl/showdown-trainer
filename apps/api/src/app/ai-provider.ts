export type AiProvider = 'kimi' | 'openai';

export const DEFAULT_KIMI_MODEL = 'kimi-k2.6';

export function getAiProvider(): AiProvider {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (provider === 'kimi' || provider === 'openai') return provider;
  if (provider) {
    throw new Error('AI_PROVIDER must be kimi or openai');
  }
  return process.env.KIMI_API_KEY?.trim() ? 'kimi' : 'openai';
}

export function getAiClientConfig() {
  const provider = getAiProvider();
  const keyName = provider === 'kimi' ? 'KIMI_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = process.env[keyName]?.trim();
  if (!apiKey) throw new Error(`${keyName} is not set`);

  return {
    apiKey,
    baseURL:
      provider === 'kimi'
        ? process.env.KIMI_BASE_URL?.trim() || 'https://api.moonshot.ai/v1'
        : undefined,
  };
}

/** Kimi-specific fields shared by the native client and AI SDK adapter. */
export function getKimiRequestOptions(modelId: string, thinking = false) {
  if (getAiProvider() !== 'kimi') return {};
  if (modelId === 'kimi-k2.6') {
    return { thinking: { type: thinking ? 'enabled' : 'disabled' } };
  }
  if (modelId === 'kimi-k3') {
    return {
      reasoning_effort: thinking ? ('high' as const) : ('low' as const),
    };
  }
  return {};
}
