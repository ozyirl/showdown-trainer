import { Injectable } from '@nestjs/common';

export interface TypeEffectiveness {
  multiplier: number;
  message: string;
}

@Injectable()
export class BattleUtilsService {
  /**
   * Calculate type effectiveness (simplified example)
   */
  getTypeEffectiveness(
    attackType: string,
    defenderTypes: string[]
  ): TypeEffectiveness {
    // Simplified type chart - just examples
    const superEffective: Record<string, string[]> = {
      Fire: ['Grass', 'Ice', 'Bug', 'Steel'],
      Water: ['Fire', 'Ground', 'Rock'],
      Grass: ['Water', 'Ground', 'Rock'],
      Electric: ['Water', 'Flying'],
      Psychic: ['Fighting', 'Poison'],
      Ghost: ['Ghost', 'Psychic'],
      Dragon: ['Dragon'],
      Dark: ['Ghost', 'Psychic'],
      Fairy: ['Fighting', 'Dragon', 'Dark'],
    };

    const notVeryEffective: Record<string, string[]> = {
      Fire: ['Fire', 'Water', 'Rock', 'Dragon'],
      Water: ['Water', 'Grass', 'Dragon'],
      Grass: ['Fire', 'Grass', 'Poison', 'Flying', 'Bug', 'Dragon', 'Steel'],
      Electric: ['Electric', 'Grass', 'Dragon'],
      Psychic: ['Psychic', 'Steel'],
      Ghost: ['Dark'],
      Dragon: ['Steel'],
      Dark: ['Fighting', 'Dark', 'Fairy'],
    };

    const immune: Record<string, string[]> = {
      Normal: ['Ghost'],
      Fighting: ['Ghost'],
      Poison: ['Steel'],
      Ground: ['Flying'],
      Electric: ['Ground'],
      Psychic: ['Dark'],
      Ghost: ['Normal'],
      Dragon: ['Fairy'],
    };

    let multiplier = 1;
    let message = 'Normal damage';

    for (const defenderType of defenderTypes) {
      if (immune[attackType]?.includes(defenderType)) {
        return {
          multiplier: 0,
          message: "It doesn't affect the target...",
        };
      }

      if (superEffective[attackType]?.includes(defenderType)) {
        multiplier *= 2;
      }

      if (notVeryEffective[attackType]?.includes(defenderType)) {
        multiplier *= 0.5;
      }
    }

    if (multiplier > 1) {
      message = "It's super effective!";
    } else if (multiplier < 1) {
      message = "It's not very effective...";
    }

    return { multiplier, message };
  }

  /**
   * Calculate damage (simplified formula)
   */
  calculateDamage(params: {
    level: number;
    attack: number;
    defense: number;
    power: number;
    multiplier?: number;
  }): number {
    const { level, attack, defense, power, multiplier = 1 } = params;

    // Simplified damage formula
    const baseDamage =
      (((2 * level) / 5 + 2) * power * (attack / defense)) / 50 + 2;

    return Math.floor(baseDamage * multiplier);
  }

  /**
   * Get a random greeting for trainers
   */
  getTrainerGreeting(trainerName: string): string {
    const greetings = [
      `${trainerName} wants to battle!`,
      `${trainerName} challenges you!`,
      `${trainerName} is ready to fight!`,
      `Battle with ${trainerName} started!`,
    ];

    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  /**
   * Format HP as percentage
   */
  formatHPPercentage(current: number, max: number): string {
    const percentage = ((current / max) * 100).toFixed(1);
    return `${current}/${max} (${percentage}%)`;
  }
}
