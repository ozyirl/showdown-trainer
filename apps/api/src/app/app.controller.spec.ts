import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonService } from '@org/common';
import { BattleUtilsService } from '@org/battle-engine';

describe('AppController', () => {
  let app: TestingModule;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      controllers: [AppController],
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
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      const appController = app.get<AppController>(AppController);
      expect(appController.getData()).toEqual({
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
