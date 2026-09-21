import { Controller, Get } from '@nestjs/common';
import { FlyCnsService } from './fly-cns.service';

@Controller('fly-cns')
export class FlyCnsController {
  constructor(private readonly flyCnsService: FlyCnsService) {}

  @Get('health')
  health(): Promise<unknown> {
    return this.flyCnsService.health();
  }
}
