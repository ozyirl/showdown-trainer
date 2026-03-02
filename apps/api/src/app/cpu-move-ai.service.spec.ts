import { CpuMoveAiService } from './cpu-move-ai.service';

describe('CpuMoveAiService chooseCpuAction fallback', () => {
  let service: CpuMoveAiService;

  beforeEach(() => {
    process.env.OPENAI_CPU_STRICT = 'false';
    delete process.env.OPENAI_API_KEY;
    service = new CpuMoveAiService();
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
