import { Injectable } from '@nestjs/common';
import { CommonService } from '@org/common';
import { BattleUtilsService } from '@org/battle-engine';

export interface Message {
  text: string;
  welcomeMessage: string;
  battleExample: {
    typeEffectiveness: string;
    damage: number;
    greeting: string;
  };
}

@Injectable()
export class AppService {
  constructor(
    private readonly commonService: CommonService,
    private readonly battleUtils: BattleUtilsService
  ) {}

  getData(): Message {
    // Example using the battle-engine library
    const typeCheck = this.battleUtils.getTypeEffectiveness('Fire', [
      'Grass',
      'Ice',
    ]);
    const damage = this.battleUtils.calculateDamage({
      level: 50,
      attack: 100,
      defense: 80,
      power: 90,
      multiplier: typeCheck.multiplier,
    });
    const greeting = this.battleUtils.getTrainerGreeting('Ash');

    return {
      text: 'Hello API',
      welcomeMessage: this.commonService.getWelcomeMessage(),
      battleExample: {
        typeEffectiveness: typeCheck.message,
        damage,
        greeting,
      },
    };
  }
}
