import { getAiProvider, getAiClientConfig } from './ai-provider';
import { getOpenAiClient } from './openai-client';

describe('AI provider configuration', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AI_PROVIDER;
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('prefers Kimi when both credentials exist and allows explicit OpenAI selection', () => {
    process.env.KIMI_API_KEY = 'test-kimi';
    process.env.OPENAI_API_KEY = 'test-openai';
    expect(getAiProvider()).toBe('kimi');
    const kimiClient = getOpenAiClient();
    expect(kimiClient.baseURL).toBe('https://api.moonshot.ai/v1');
    expect(kimiClient.apiKey).toBe('test-kimi');
    process.env.AI_PROVIDER = 'openai';
    const openaiClient = getOpenAiClient();
    expect(openaiClient).not.toBe(kimiClient);
    expect(openaiClient.apiKey).toBe('test-openai');
  });

  it('fails on a missing Kimi key instead of sending requests to OpenAI', () => {
    process.env.AI_PROVIDER = 'kimi';
    process.env.OPENAI_API_KEY = 'test-openai';
    expect(() => getAiClientConfig()).toThrow('KIMI_API_KEY is not set');
  });

  it('rejects unknown providers', () => {
    process.env.AI_PROVIDER = 'typo';
    expect(() => getAiProvider()).toThrow('AI_PROVIDER must be kimi or openai');
  });
});
