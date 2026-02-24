import {
  calibrateLevels1v1,
  type CalibrationOptions,
  type PokemonSpec,
} from '@org/battle-engine';

describe('calibrateLevels1v1', () => {
  const baseOptions: CalibrationOptions = {
    format: 'gen9customgame',
    trialsPerStep: 20,
    maxSteps: 8,
    targetWinrate: 0.5,
    tolerance: 0.08,
    minLevel: 50,
    maxLevel: 100,
    stepSize: 2,
  };

  it('reduces p1 level when p1 is too strong and approaches target winrate', async () => {
    const p1: PokemonSpec = { species: 'Rayquaza', level: 100 };
    const p2: PokemonSpec = { species: 'Sylveon', level: 100 };

    const result = await calibrateLevels1v1(
      p1,
      p2,
      { ...baseOptions, maxSteps: 12 },
      createDeterministicSimulator({
        speciesStrength: { Rayquaza: 30, Sylveon: 0 },
      })
    );

    expect(result.p1Level).toBeLessThan(100);
    expect(result.p2Level).toBe(100);
    expect(result.p1Winrate).toBeGreaterThanOrEqual(0.42);
    expect(result.p1Winrate).toBeLessThanOrEqual(0.58);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('keeps levels unchanged when matchup is already near 50/50', async () => {
    const p1: PokemonSpec = { species: 'Garchomp', level: 100 };
    const p2: PokemonSpec = { species: 'Salamence', level: 100 };

    const result = await calibrateLevels1v1(
      p1,
      p2,
      baseOptions,
      createDeterministicSimulator({
        speciesStrength: { Garchomp: 1, Salamence: 0 },
      })
    );

    expect(result.p1Level).toBe(100);
    expect(result.p2Level).toBe(100);
    expect(result.steps[0].winrate).toBeGreaterThanOrEqual(0.42);
    expect(result.steps[0].winrate).toBeLessThanOrEqual(0.58);
  });

  it('uses symmetric fallback when p1 is clamped and still too weak', async () => {
    const p1: PokemonSpec = { species: 'Magikarp', level: 50 };
    const p2: PokemonSpec = { species: 'Arceus', level: 100 };

    const result = await calibrateLevels1v1(
      p1,
      p2,
      { ...baseOptions, maxSteps: 20, stepSize: 5 },
      createDeterministicSimulator({
        speciesStrength: { Magikarp: -60, Arceus: 60 },
      })
    );

    expect(result.p1Level).toBe(100);
    expect(result.p2Level).toBeLessThan(100);
    expect(result.p2Level).toBeGreaterThanOrEqual(50);
  });

  it('never returns levels outside configured bounds', async () => {
    const p1: PokemonSpec = { species: 'X', level: 999 };
    const p2: PokemonSpec = { species: 'Y', level: 1 };

    const result = await calibrateLevels1v1(
      p1,
      p2,
      { ...baseOptions, minLevel: 50, maxLevel: 100, stepSize: 10 },
      createDeterministicSimulator({
        speciesStrength: { X: 200, Y: -200 },
      })
    );

    expect(result.p1Level).toBeGreaterThanOrEqual(50);
    expect(result.p1Level).toBeLessThanOrEqual(100);
    expect(result.p2Level).toBeGreaterThanOrEqual(50);
    expect(result.p2Level).toBeLessThanOrEqual(100);
  });
});

function createDeterministicSimulator(config: {
  speciesStrength: Record<string, number>;
}) {
  const counters = new Map<string, number>();

  return async (
    p1: PokemonSpec,
    p2: PokemonSpec,
    _format: string
  ): Promise<'p1' | 'p2'> => {
    const s1 = (config.speciesStrength[p1.species] ?? 0) + p1.level;
    const s2 = (config.speciesStrength[p2.species] ?? 0) + p2.level;
    const diff = s1 - s2;

    // Convert score diff to a deterministic pseudo-winrate over 20 trials:
    // diff=0 => 10/20 wins, diff=12 => 12/20 wins, diff=-12 => 8/20 wins, etc.
    const desiredWins = clamp(Math.round(10 + diff / 6), 0, 20);

    // Derive a deterministic trial index from mutable closure state.
    const key = `${p1.species}|${p2.species}|${p1.level}|${p2.level}`;
    const count = counters.get(key) ?? 0;
    const trialIndex = count % 20;
    counters.set(key, count + 1);

    return trialIndex < desiredWins ? 'p1' : 'p2';
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
