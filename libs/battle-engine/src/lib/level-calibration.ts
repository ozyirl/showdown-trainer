export type PokemonSpec = {
  species: string;
  level: number;
  moves?: string[];
};

export type CalibrationOptions = {
  format: string;
  trialsPerStep: number;
  maxSteps: number;
  targetWinrate: number;
  tolerance: number;
  minLevel: number;
  maxLevel: number;
  stepSize: number;
  seed?: number;
};

export type CalibrationResult = {
  p1Level: number;
  p2Level: number;
  p1Winrate: number;
  steps: Array<{ p1Level: number; p2Level: number; winrate: number }>;
};

type Winner = 'p1' | 'p2';

export async function calibrateLevels1v1(
  p1: PokemonSpec,
  p2: PokemonSpec,
  opts: CalibrationOptions,
  simulateBattle: (
    p1: PokemonSpec,
    p2: PokemonSpec,
    format: string
  ) => Promise<Winner>
): Promise<CalibrationResult> {
  const minLevel = Math.min(opts.minLevel, opts.maxLevel);
  const maxLevel = Math.max(opts.minLevel, opts.maxLevel);
  const target = opts.targetWinrate;
  const tolerance = Math.max(0, opts.tolerance);
  const trialsPerStep = Math.max(1, Math.floor(opts.trialsPerStep));
  const maxSteps = Math.max(1, Math.floor(opts.maxSteps));
  const stepSize = Math.max(1, Math.floor(opts.stepSize));

  let p1Level = clamp(Math.round(p1.level), minLevel, maxLevel);
  let p2Level = clamp(Math.round(p2.level), minLevel, maxLevel);

  const steps: CalibrationResult['steps'] = [];
  let lastWinrate = 0;

  for (let step = 0; step < maxSteps; step++) {
    const wins = await runTrials(
      trialsPerStep,
      { ...p1, level: p1Level },
      { ...p2, level: p2Level },
      opts.format,
      simulateBattle
    );

    lastWinrate = wins / trialsPerStep;
    steps.push({ p1Level, p2Level, winrate: lastWinrate });

    if (withinTolerance(lastWinrate, target, tolerance)) {
      break;
    }

    const p1TooStrong = lastWinrate > target + tolerance;
    const nextP1Level = clamp(
      p1Level + (p1TooStrong ? -stepSize : stepSize),
      minLevel,
      maxLevel
    );

    if (nextP1Level !== p1Level) {
      p1Level = nextP1Level;
      continue;
    }

    // Optional symmetric fallback when p1 is clamped and still outside tolerance.
    const nextP2Level = clamp(
      p2Level + (p1TooStrong ? stepSize : -stepSize),
      minLevel,
      maxLevel
    );

    if (nextP2Level === p2Level) {
      break;
    }

    p2Level = nextP2Level;
  }

  return {
    p1Level,
    p2Level,
    p1Winrate: lastWinrate,
    steps,
  };
}

async function runTrials(
  trials: number,
  p1: PokemonSpec,
  p2: PokemonSpec,
  format: string,
  simulateBattle: (p1: PokemonSpec, p2: PokemonSpec, format: string) => Promise<Winner>
): Promise<number> {
  let p1Wins = 0;

  for (let i = 0; i < trials; i++) {
    const winner = await simulateBattle(p1, p2, format);
    if (winner === 'p1') {
      p1Wins++;
    }
  }

  return p1Wins;
}

function withinTolerance(winrate: number, target: number, tolerance: number): boolean {
  return winrate >= target - tolerance && winrate <= target + tolerance;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/*
Integration sketch (BattleService):
1) Build PokemonSpec for p1/p2 using selected species/moves and initial levels.
2) Call calibrateLevels1v1(p1, p2, opts, async (left, right, format) => {
     // spin up a Showdown battle with left/right specs, run to completion, return "p1" | "p2"
   });
3) Use calibrated levels in the real PvE battle start flow.
*/

