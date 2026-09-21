import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BattleController } from './battle.controller';
import { BattleService } from './battle.service';
import { BattleSessionManager } from './battle-session.manager';
import { OrgCommonModule } from '@org/common';
import { BattleEngineModule } from '@org/battle-engine';
import { CpuMoveAiService } from './cpu-move-ai.service';
import { CopilotService } from './copilot.service';
import { TeamsModule } from './teams/teams.module';
import { FlyCnsController } from './fly-cns.controller';
import { FlyCnsService } from './fly-cns.service';

@Module({
  imports: [OrgCommonModule, BattleEngineModule, TeamsModule],
  controllers: [AppController, BattleController, FlyCnsController],
  providers: [
    AppService,
    BattleService,
    BattleSessionManager,
    CpuMoveAiService,
    CopilotService,
    FlyCnsService,
  ],
})
export class AppModule {}
