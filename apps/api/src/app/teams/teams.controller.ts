import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ClerkAuthGuard, CurrentUser, type ClerkUser } from '@org/common';
import { TeamsService } from './teams.service';
import { validateCreateTeamDto, validateUpdateTeamDto } from './teams.validation';

@UseGuards(ClerkAuthGuard)
@Controller('teams')
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Get()
  async listTeams(@CurrentUser() user: ClerkUser) {
    return this.teamsService.listTeams(user.userId);
  }

  @Get(':id')
  async getTeam(@CurrentUser() user: ClerkUser, @Param('id') id: string) {
    return this.teamsService.getTeamById(user.userId, id);
  }

  @Post()
  async createTeam(@CurrentUser() user: ClerkUser, @Body() body: unknown) {
    const dto = validateCreateTeamDto(body);
    return this.teamsService.createTeam(user.userId, dto);
  }

  @Patch(':id')
  async updateTeam(
    @CurrentUser() user: ClerkUser,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const dto = validateUpdateTeamDto(body);
    return this.teamsService.updateTeam(user.userId, id, dto);
  }

  @Put(':id')
  async replaceTeam(
    @CurrentUser() user: ClerkUser,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const dto = validateUpdateTeamDto(body);
    return this.teamsService.updateTeam(user.userId, id, dto);
  }

  @Delete(':id')
  async deleteTeam(@CurrentUser() user: ClerkUser, @Param('id') id: string) {
    return this.teamsService.deleteTeam(user.userId, id);
  }
}
