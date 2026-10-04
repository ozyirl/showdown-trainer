import { getOpenAiClient } from '../openai-client';
import { TeambuilderAiService } from './teambuilder-ai.service';

describe('Kimi teambuilder tool loop', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('uses Kimi without an OpenAI key and passes verified tool results back', async () => {
    process.env = {
      ...originalEnv,
      AI_PROVIDER: 'kimi',
      KIMI_API_KEY: 'test-kimi-key',
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.KIMI_MODEL;
    delete process.env.KIMI_TEAMBUILDER_MODEL;
    const assistantMessage = {
      role: 'assistant',
      content: null,
      reasoning_content: 'Preserve this field.',
      tool_calls: [
        {
          id: 'lookup-1',
          type: 'function',
          function: { name: 'lookupPokemon', arguments: '{"name":"Pikachu"}' },
        },
      ],
    };
    const create = jest
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: assistantMessage, finish_reason: 'tool_calls' }],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: { role: 'assistant', content: 'Pikachu is Electric.' },
            finish_reason: 'stop',
          },
        ],
      });
    jest
      .spyOn(getOpenAiClient().chat.completions, 'create')
      .mockImplementation(create);
    const response = await new TeambuilderAiService().chat({
      messages: [{ role: 'user', content: 'Check Pikachu types.' }],
    });
    expect(response.message).toBe('Pikachu is Electric.');
    expect(create).toHaveBeenCalledTimes(2);
    const secondRequest = create.mock.calls[1][0];
    expect(secondRequest.model).toBe('kimi-k2.6');
    expect(secondRequest.thinking).toEqual({ type: 'disabled' });
    expect(secondRequest.messages).toContain(assistantMessage);
    const toolResult = secondRequest.messages.find(
      (message: { role: string }) => message.role === 'tool'
    );
    expect(JSON.parse(toolResult.content).types).toEqual(['Electric']);
    expect(response.slotUpdates).toEqual([]);
  });
});
