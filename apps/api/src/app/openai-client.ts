import OpenAI from 'openai';

let openAiClient: OpenAI | null = null;

export function getOpenAiClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  if (!openAiClient) {
    openAiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openAiClient;
}
