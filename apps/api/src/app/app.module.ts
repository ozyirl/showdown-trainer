import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BattleController } from './battle.controller';
import { BattleService } from './battle.service';
import { BattleSessionManager } from './battle-session.manager';
import { OrgCommonModule } from '@org/common';
import { BattleEngineModule } from '@org/battle-engine';
import { CpuMoveAiService } from './cpu-move-ai.service';
import { TeamsModule } from './teams/teams.module';

@Module({
  imports: [OrgCommonModule, BattleEngineModule, TeamsModule],
  controllers: [AppController, BattleController],
  providers: [
    AppService,
    BattleService,
    BattleSessionManager,
    CpuMoveAiService,
  ],
})
export class AppModule {}
