import { Controller, Get, Logger } from '@nestjs/common';
import { FlyCnsService } from './fly-cns.service';

@Controller('fly-cns')
export class FlyCnsController {
  private readonly logger = new Logger(FlyCnsController.name);

  constructor(private readonly flyCnsService: FlyCnsService) {}

  @Get('health')
  health(): Promise<unknown> {
    return this.flyCnsService.health();
  }

  @Get('predict-debug')
  async debugPredict(): Promise<unknown> {
    const response = await this.flyCnsService.debugPredict();
    this.logger.log(`FlyCNS /predict response: ${JSON.stringify(response)}`);
    return response;
  }
}
