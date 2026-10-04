import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import {
  createModel,
  getTokenBudget,
  isReasoningModel,
  resolveCopilotModelId,
  resolveCpuModelId,
  resolveModelId,
} from './model-utils';

describe('model-utils resolution', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (/^(KIMI_|OPENAI_)/.test(key)) delete process.env[key];
    }
    process.env.AI_PROVIDER = 'openai';
    delete process.env.OPENAI_CPU_MODEL;
    delete process.env.OPENAI_CPU_FAST_MODEL;
    delete process.env.OPENAI_CPU_REASONING_MODEL;
    delete process.env.OPENAI_COPILOT_MODEL;
    delete process.env.OPENAI_COPILOT_COACH_MODEL;
    delete process.env.OPENAI_COPILOT_DEEP_MODEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defaults fast cpu profile to the low-latency model', () => {
    expect(resolveCpuModelId('fast')).toBe('gpt-4.1-nano-2025-04-14');
  });

  it('defaults reasoning cpu profile to gpt-5-nano when no override is set', () => {
    expect(resolveCpuModelId('reasoning')).toBe('gpt-5-nano-2025-08-07');
  });

  it('treats unspecified copilot mode as coach', () => {
    expect(resolveCopilotModelId()).toBe('gpt-4.1-nano-2025-04-14');
  });

  it('routes every Kimi role without using stale OpenAI model overrides', () => {
    process.env.AI_PROVIDER = 'kimi';
    process.env.OPENAI_CPU_MODEL = 'gpt-5-nano';
    process.env.OPENAI_TEAMBUILDER_MODEL = 'gpt-4.1-nano';
    expect(resolveCpuModelId()).toBe('kimi-k2.6');
    expect(resolveCpuModelId('fast')).toBe('kimi-k2.6');
    expect(resolveCpuModelId('reasoning')).toBe('kimi-k3');
    expect(resolveCopilotModelId()).toBe('kimi-k2.6');
    expect(resolveCopilotModelId('deep')).toBe('kimi-k3');
    expect(resolveModelId('OPENAI_TEAMBUILDER_MODEL')).toBe('kimi-k2.6');
    expect(resolveModelId('OPENAI_COPILOT_EXTRACTOR_MODEL')).toBe('kimi-k2.6');
  });

  it('honors Kimi role overrides and shared model overrides', () => {
    process.env.AI_PROVIDER = 'kimi';
    process.env.KIMI_MODEL = 'kimi-k2.6';
    process.env.KIMI_CPU_REASONING_MODEL = 'kimi-k3';
    process.env.KIMI_COPILOT_DEEP_MODEL = 'kimi-k3';
    expect(resolveCpuModelId('reasoning')).toBe('kimi-k3');
    expect(resolveCopilotModelId('deep')).toBe('kimi-k3');
    expect(resolveCpuModelId('fast')).toBe('kimi-k2.6');
    delete process.env.KIMI_MODEL;
    process.env.KIMI_CPU_MODEL = 'kimi-k3';
    expect(resolveCopilotModelId('deep')).toBe('kimi-k3');
  });

  it('budgets thinking separately from instant Kimi output', () => {
    process.env.AI_PROVIDER = 'kimi';
    expect(isReasoningModel('kimi-k2.6')).toBe(false);
    expect(isReasoningModel('kimi-k2.6', true)).toBe(true);
    expect(isReasoningModel('kimi-k3')).toBe(true);
    expect(getTokenBudget('kimi-k2.6', 'action')).toBe(512);
    expect(getTokenBudget('kimi-k2.6', 'copilot')).toBe(2048);
    expect(getTokenBudget('kimi-k3', 'action')).toBe(16384);
  });

  it('uses Kimi Chat Completions for AI SDK text and schema output', async () => {
    process.env.AI_PROVIDER = 'kimi';
    process.env.KIMI_API_KEY = 'test-kimi-key';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: 'test-completion',
            object: 'chat.completion',
            created: 1,
            model: 'kimi-k2.6',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"choice":"move 1"}' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 10,
              total_tokens: 20,
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        )
    );

    const textResult = await generateText({
      model: createModel('kimi-k2.6'),
      prompt: 'Choose a move.',
      maxOutputTokens: 512,
    });
    expect(textResult.text).toBe('{"choice":"move 1"}');
    const objectResult = await generateObject({
      model: createModel('kimi-k2.6'),
      schema: z.object({ choice: z.string() }),
      prompt: 'Extract JSON.',
    });
    expect(objectResult.object.choice).toBe('move 1');
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.moonshot.ai/v1/chat/completions');
      const body = JSON.parse(init?.body as string);
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.reasoning_effort).toBeUndefined();
    }
    const structuredBody = JSON.parse(
      fetchMock.mock.calls[1][1]?.body as string
    );
    expect(structuredBody.response_format.type).toBe('json_schema');
    await generateText({
      model: createModel('kimi-k3', true),
      prompt: 'Analyze.',
    });
    const deepBody = JSON.parse(fetchMock.mock.calls[2][1]?.body as string);
    expect(deepBody.reasoning_effort).toBe('high');
    expect(deepBody.thinking).toBeUndefined();
  });
});
