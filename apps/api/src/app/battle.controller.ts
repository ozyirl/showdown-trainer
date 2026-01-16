import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { BattleService } from './battle.service';
import { BattleSessionManager } from './battle-session.manager';

@Controller('battle')
export class BattleController {
  constructor(
    private readonly battleService: BattleService,
    private readonly battleSessionManager: BattleSessionManager
  ) {}

  @Get('simulate')
  async simulateBattle() {
    return this.battleService.simulateBattle();
  }

  @Get('pokemon/:name')
  async getPokemonInfo(@Param('name') name: string) {
    return this.battleService.getPokemonInfo(name);
  }

  // Interactive battle endpoints
  @Post('start')
  async startBattle() {
    return this.battleSessionManager.createBattle();
  }

  @Post(':id/move')
  async submitMove(
    @Param('id') battleId: string,
    @Body() body: { player: 'p1' | 'p2'; moveIndex: number }
  ) {
    return this.battleSessionManager.submitMove(
      battleId,
      body.player,
      body.moveIndex
    );
  }

  @Get(':id/state')
  async getBattleState(@Param('id') battleId: string) {
    return this.battleSessionManager.getBattleState(battleId);
  }
}
