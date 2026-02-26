import { Controller, Get, UseGuards } from '@nestjs/common';
import { CommonService } from './common.service';
import { ClerkAuthGuard } from './clerk-auth.guard';
import { CurrentUser } from './current-user.decorator';
import type { ClerkUser } from './clerk-auth.service';

@Controller('common')
export class CommonController {
  constructor(private readonly commonService: CommonService) {}

  @Get('health')
  health() {
    return {
      ok: true,
      message: this.commonService.getWelcomeMessage(),
    };
  }

  @UseGuards(ClerkAuthGuard)
  @Get('me')
  me(@CurrentUser() user: ClerkUser) {
    return this.commonService.getRuntimeStatus(user);
  }
}
