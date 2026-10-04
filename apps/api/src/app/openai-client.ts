import OpenAI from 'openai';
import { getAiClientConfig } from './ai-provider';

let cachedClient: { apiKey: string; baseURL?: string; client: OpenAI } | null =
  null;

export function getOpenAiClient(): OpenAI {
  const config = getAiClientConfig();

  if (
    !cachedClient ||
    cachedClient.apiKey !== config.apiKey ||
    cachedClient.baseURL !== config.baseURL
  ) {
    cachedClient = { ...config, client: new OpenAI(config) };
  }

  return cachedClient.client;
}
