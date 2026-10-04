import { CpuMoveAiService } from './cpu-move-ai.service';
import * as clients from './openai-client';

describe('CpuMoveAiService chooseCpuAction fallback', () => {
  let service: CpuMoveAiService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, AI_PROVIDER: 'openai' };
    process.env.OPENAI_CPU_STRICT = 'false';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_CPU_FAST_MODEL;
    delete process.env.OPENAI_CPU_REASONING_MODEL;
    delete process.env.OPENAI_CPU_MODEL;
    service = new CpuMoveAiService();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it.each(['fast', 'reasoning'] as const)(
    'streams a Kimi %s CPU decision with provider-specific options',
    async (profile) => {
      process.env.AI_PROVIDER = 'kimi';
      process.env.KIMI_API_KEY = 'test-kimi-key';
      delete process.env.KIMI_MODEL;
      delete process.env.KIMI_CPU_MODEL;
      delete process.env.KIMI_CPU_FAST_MODEL;
      delete process.env.KIMI_CPU_REASONING_MODEL;
      const create = jest.fn().mockImplementation(async function* () {
        yield {
          choices: [{ delta: { reasoning_content: 'Private analysis' } }],
        };
        yield {
          choices: [
            {
              delta: { content: '{"choice":"move 1"}' },
              finish_reason: 'stop',
            },
          ],
        };
      });
      jest
        .spyOn(clients.getOpenAiClient().chat.completions, 'create')
        .mockImplementation(create);
      const result = await service.chooseCpuAction({
        battleId: 'kimi-test',
        turn: 1,
        modelProfile: profile,
        cpuPokemonName: 'Pikachu',
        playerPokemonName: 'Squirtle',
        availableMoves: [{ index: 1, name: 'Thunderbolt' }],
      });
      expect(result.source).toBe('model');
      expect(result.choice).toBe('move 1');
      expect(result.rawResponse).toBe('{"choice":"move 1"}');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining(
          profile === 'fast'
            ? {
                model: 'kimi-k2.6',
                thinking: { type: 'disabled' },
                max_completion_tokens: 512,
              }
            : {
                model: 'kimi-k3',
                reasoning_effort: 'high',
                max_completion_tokens: 16384,
              }
        )
      );
    }
  );

  it('resolves cpu model profiles through the routing abstraction', () => {
    process.env.OPENAI_CPU_MODEL = 'base-model';
    process.env.OPENAI_CPU_FAST_MODEL = 'fast-model';
    process.env.OPENAI_CPU_REASONING_MODEL = 'reasoning-model';

    expect(service.getDefaultModelId()).toBe('base-model');
    expect(service.getDefaultModelId('fast')).toBe('fast-model');
    expect(service.getDefaultModelId('reasoning')).toBe('reasoning-model');
  });

  it('picks a legal switch on forced-switch turns', async () => {
    const decision = await service.chooseCpuAction({
      battleId: 'b1',
      turn: 3,
      cpuPokemonName: 'Gengar',
      playerPokemonName: 'Tyranitar',
      forceSwitch: true,
      availableMoves: [],
      availableSwitches: [
        { slot: 2, name: 'Rotom-Wash', hpPercent: 100, status: null },
        { slot: 3, name: 'Dragonite', hpPercent: 50, status: 'brn' },
      ],
    });

    expect(decision.choice).toBe('switch 2');
    expect(decision.actionType).toBe('switch');
  });

  it('avoids immune moves in fallback action selection', async () => {
    const decision = await service.chooseCpuAction({
      battleId: 'b2',
      turn: 4,
      cpuPokemonName: 'Pikachu',
      playerPokemonName: 'Garchomp',
      availableMoves: [
        {
          index: 1,
          name: 'Thunderbolt',
          type: 'Electric',
          power: 90,
          pp: 24,
          isImmune: true,
          effectivenessMultiplier: 0,
        },
        {
          index: 2,
          name: 'Iron Tail',
          type: 'Steel',
          power: 100,
          pp: 24,
          isImmune: false,
          effectivenessMultiplier: 1,
        },
      ],
      availableSwitches: [],
    });

    expect(decision.choice).toBe('move 2');
    expect(decision.actionType).toBe('move');
  });
});
