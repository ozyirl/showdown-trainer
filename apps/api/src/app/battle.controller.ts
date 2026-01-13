import { Controller, Get, Param } from '@nestjs/common';
import { BattleService } from './battle.service';

@Controller('battle')
export class BattleController {
  constructor(private readonly battleService: BattleService) {}

  @Get('simulate')
  async simulateBattle() {
    return this.battleService.simulateBattle();
  }

  @Get('pokemon/:name')
  async getPokemonInfo(@Param('name') name: string) {
    return this.battleService.getPokemonInfo(name);
  }
}
