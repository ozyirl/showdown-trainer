import { Module } from '@nestjs/common';
import { BattleUtilsService } from './battle-utils.service';

@Module({
  controllers: [],
  providers: [BattleUtilsService],
  exports: [BattleUtilsService],
})
export class BattleEngineModule {}
