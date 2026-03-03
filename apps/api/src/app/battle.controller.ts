import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { BattleService } from './battle.service';
import type { StartBattleRequest } from './battle.service';
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

  @Get('pokemon')
  async listPokemon(
    @Query('q') q?: string,
    @Query('limit') limit?: string
  ) {
    const parsedLimit = limit ? Number(limit) : 50;
    return this.battleService.listPokemon(q, parsedLimit);
  }

  @Get('pokemon/:name/moves')
  async getPokemonMoves(
    @Param('name') name: string,
    @Query('limit') limit?: string
  ) {
    const parsedLimit = limit ? Number(limit) : 200;
    return this.battleService.getPokemonMoves(name, parsedLimit);
  }

  // Interactive battle endpoints
  @Post('start')
  async startBattle(@Body() body?: StartBattleRequest) {
    return this.battleSessionManager.createBattle(body);
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

  @Post(':id/action')
  async submitAction(
    @Param('id') battleId: string,
    @Body() body: { player: 'p1' | 'p2'; choice?: string; moveIndex?: number }
  ) {
    if (typeof body.choice === 'string' && body.choice.trim()) {
      return this.battleSessionManager.submitAction(
        battleId,
        body.player,
        body.choice
      );
    }

    if (typeof body.moveIndex === 'number') {
      return this.battleSessionManager.submitMove(
        battleId,
        body.player,
        body.moveIndex
      );
    }

    return this.battleSessionManager.submitAction(
      battleId,
      body.player,
      'default'
    );
  }

  @Post(':id/continue')
  async continueBattle(@Param('id') battleId: string) {
    return this.battleSessionManager.continueBattle(battleId);
  }

  @Post(':id/ack')
  async ackEvent(
    @Param('id') battleId: string,
    @Body() body: { eventSeq: number }
  ) {
    return this.battleSessionManager.ackEvent(battleId, body.eventSeq);
  }

  @Get(':id/events')
  async getBattleEvents(
    @Param('id') battleId: string,
    @Query('afterSeq') afterSeq?: string,
    @Query('limit') limit?: string
  ) {
    return this.battleSessionManager.getBattleEvents(
      battleId,
      afterSeq ? Number(afterSeq) : 0,
      limit ? Number(limit) : 200
    );
  }

  @Get(':id/state')
  async getBattleState(@Param('id') battleId: string) {
    return this.battleSessionManager.getBattleState(battleId);
  }
}
