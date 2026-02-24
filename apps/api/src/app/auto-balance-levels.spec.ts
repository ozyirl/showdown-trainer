import {
  autoBalanceLevels,
  computePowerScore,
  type PokemonBaseStats,
} from './auto-balance-levels';

describe('autoBalanceLevels', () => {
  const rayquaza: PokemonBaseStats = {
    hp: 105,
    atk: 150,
    def: 90,
    spa: 150,
    spd: 90,
    spe: 95,
  };

  const sylveon: PokemonBaseStats = {
    hp: 95,
    atk: 65,
    def: 65,
    spa: 110,
    spd: 130,
    spe: 60,
  };

  const garchomp: PokemonBaseStats = {
    hp: 108,
    atk: 130,
    def: 95,
    spa: 80,
    spd: 85,
    spe: 102,
  };

  const salamence: PokemonBaseStats = {
    hp: 95,
    atk: 135,
    def: 80,
    spa: 110,
    spd: 80,
    spe: 100,
  };

  it('reduces level for stronger Pokemon (Rayquaza vs Sylveon)', () => {
    const result = autoBalanceLevels(rayquaza, sylveon);
    expect(computePowerScore(rayquaza)).toBeGreaterThan(computePowerScore(sylveon));
    expect(result.levelA).toBeLessThan(result.levelB);
    expect(result.levelB).toBe(100);
  });

  it('keeps levels close for similar power Pokemon', () => {
    const result = autoBalanceLevels(garchomp, salamence);
    expect(Math.abs(result.levelA - result.levelB)).toBeLessThanOrEqual(5);
  });

  it('never drops below level 50', () => {
    const absurdlyStrong: PokemonBaseStats = {
      hp: 255,
      atk: 255,
      def: 255,
      spa: 255,
      spd: 255,
      spe: 255,
    };

    const veryWeak: PokemonBaseStats = {
      hp: 1,
      atk: 1,
      def: 1,
      spa: 1,
      spd: 1,
      spe: 1,
    };

    const result = autoBalanceLevels(absurdlyStrong, veryWeak);
    expect(result.levelA).toBe(50);
    expect(result.levelB).toBe(100);
  });
});

