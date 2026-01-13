import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BattleController } from './battle.controller';
import { BattleService } from './battle.service';
import { OrgCommonModule } from '@org/common';

@Module({
  imports: [OrgCommonModule],
  controllers: [AppController, BattleController],
  providers: [AppService, BattleService],
})
export class AppModule {}
