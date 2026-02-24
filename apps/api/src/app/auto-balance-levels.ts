export interface PokemonBaseStats {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export function computePowerScore(p: PokemonBaseStats): number {
  const bst = p.hp + p.atk + p.def + p.spa + p.spd + p.spe;
  return bst + 0.5 * p.spe + 0.5 * Math.max(p.atk, p.spa);
}

export function autoBalanceLevels(
  pokemonA: PokemonBaseStats,
  pokemonB: PokemonBaseStats,
  baseLevel = 100
): { levelA: number; levelB: number } {
  const clampedBase = clamp(Math.round(baseLevel), 50, 100);
  const scoreA = computePowerScore(pokemonA);
  const scoreB = computePowerScore(pokemonB);

  if (scoreA === scoreB) {
    return { levelA: clampedBase, levelB: clampedBase };
  }

  const aIsStronger = scoreA > scoreB;
  const strongerScore = aIsStronger ? scoreA : scoreB;
  const weakerScore = aIsStronger ? scoreB : scoreA;
  const gap = strongerScore - weakerScore;
  const levelPenalty = Math.round(gap / 12);
  const strongerLevel = clamp(clampedBase - levelPenalty, 50, 100);
  const weakerLevel = clampedBase;

  return aIsStronger
    ? { levelA: strongerLevel, levelB: weakerLevel }
    : { levelA: weakerLevel, levelB: strongerLevel };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

