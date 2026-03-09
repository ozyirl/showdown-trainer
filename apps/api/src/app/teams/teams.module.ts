import { Module } from '@nestjs/common';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { TeambuilderAiService } from './teambuilder-ai.service';

@Module({
  controllers: [TeamsController],
  providers: [TeamsService, TeambuilderAiService],
})
export class TeamsModule {}
