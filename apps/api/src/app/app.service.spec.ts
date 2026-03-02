import { Test } from '@nestjs/testing';
import { AppService } from './app.service';
import { CommonService } from '@org/common';
import { BattleUtilsService } from '@org/battle-engine';

describe('AppService', () => {
  let service: AppService;

  beforeAll(async () => {
    const app = await Test.createTestingModule({
      providers: [
        AppService,
        {
          provide: CommonService,
          useValue: {
            getWelcomeMessage: () => 'Welcome',
          },
        },
        {
          provide: BattleUtilsService,
          useValue: {
            getTypeEffectiveness: () => ({ multiplier: 2, message: 'Super effective' }),
            calculateDamage: () => 120,
            getTrainerGreeting: () => 'Hi trainer',
          },
        },
      ],
    }).compile();

    service = app.get<AppService>(AppService);
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      expect(service.getData()).toEqual({
        text: 'Hello API',
        welcomeMessage: 'Welcome',
        battleExample: {
          typeEffectiveness: 'Super effective',
          damage: 120,
          greeting: 'Hi trainer',
        },
      });
    });
  });
});
