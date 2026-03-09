import {
  BadRequestException,
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
import { TeambuilderAiService } from './teambuilder-ai.service';
import { validateCreateTeamDto, validateUpdateTeamDto } from './teams.validation';
import type { TeambuilderChatRequest } from './teambuilder-ai.types';

@UseGuards(ClerkAuthGuard)
@Controller('teams')
export class TeamsController {
  constructor(
    private readonly teamsService: TeamsService,
    private readonly teambuilderAiService: TeambuilderAiService,
  ) {}

  @Get()
  async listTeams(@CurrentUser() user: ClerkUser) {
    return this.teamsService.listTeams(user.userId);
  }

  @Post('chat')
  async chat(@CurrentUser() _user: ClerkUser, @Body() body: unknown) {
    const request = this.validateChatRequest(body);
    return this.teambuilderAiService.chat(request);
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

  private validateChatRequest(body: unknown): TeambuilderChatRequest {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Request body must be an object');
    }
    const data = body as Record<string, unknown>;
    if (!Array.isArray(data.messages) || data.messages.length === 0) {
      throw new BadRequestException('messages must be a non-empty array');
    }
    for (const msg of data.messages) {
      if (
        !msg ||
        typeof msg !== 'object' ||
        (msg.role !== 'user' && msg.role !== 'assistant') ||
        typeof msg.content !== 'string'
      ) {
        throw new BadRequestException(
          'Each message must have role ("user"|"assistant") and content (string)',
        );
      }
    }
    return {
      messages: data.messages,
      currentSlots: Array.isArray(data.currentSlots)
        ? data.currentSlots
        : undefined,
      format: typeof data.format === 'string' ? data.format : undefined,
    } as TeambuilderChatRequest;
  }
}
