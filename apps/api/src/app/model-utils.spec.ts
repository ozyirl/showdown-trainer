import { resolveCopilotModelId, resolveCpuModelId } from './model-utils';

describe('model-utils resolution', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
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

  it('defaults fast cpu profile to the low-latency model', () => {
    expect(resolveCpuModelId('fast')).toBe('gpt-4.1-nano-2025-04-14');
  });

  it('defaults reasoning cpu profile to gpt-5-nano when no override is set', () => {
    expect(resolveCpuModelId('reasoning')).toBe('gpt-5-nano-2025-08-07');
  });

  it('treats unspecified copilot mode as coach', () => {
    expect(resolveCopilotModelId()).toBe('gpt-4.1-nano-2025-04-14');
  });
});
