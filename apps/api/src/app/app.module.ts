import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { OrgCommonModule } from '@org/common';

@Module({
  imports: [OrgCommonModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
