import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '@org/common';
import type { CreateTeamDto, TeamRecord, UpdateTeamDto } from './teams.types';

@Injectable()
export class TeamsService {
  private readonly tableName = 'teambuilder_teams';

  constructor(private readonly supabaseService: SupabaseService) {}

  async listTeams(userId: string): Promise<TeamRecord[]> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from(this.tableName)
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return (data ?? []) as TeamRecord[];
  }

  async getTeamById(userId: string, teamId: string): Promise<TeamRecord> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from(this.tableName)
      .select('*')
      .eq('user_id', userId)
      .eq('id', teamId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    if (!data) {
      throw new NotFoundException(`Team ${teamId} not found`);
    }

    return data as TeamRecord;
  }

  async createTeam(userId: string, dto: CreateTeamDto): Promise<TeamRecord> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from(this.tableName)
      .insert({
        user_id: userId,
        name: dto.name,
        format: dto.format ?? null,
        notes: dto.notes ?? null,
        slots: dto.slots ?? [],
      })
      .select('*')
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data as TeamRecord;
  }

  async updateTeam(
    userId: string,
    teamId: string,
    dto: UpdateTeamDto
  ): Promise<TeamRecord> {
    const supabase = this.supabaseService.getClient();
    const updatePayload: Record<string, unknown> = {};

    if (dto.name !== undefined) updatePayload.name = dto.name;
    if (dto.format !== undefined) updatePayload.format = dto.format ?? null;
    if (dto.notes !== undefined) updatePayload.notes = dto.notes ?? null;
    if (dto.slots !== undefined) updatePayload.slots = dto.slots;

    const { data, error } = await supabase
      .from(this.tableName)
      .update(updatePayload)
      .eq('user_id', userId)
      .eq('id', teamId)
      .select('*')
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    if (!data) {
      throw new NotFoundException(`Team ${teamId} not found`);
    }

    return data as TeamRecord;
  }

  async deleteTeam(userId: string, teamId: string): Promise<{ deleted: true }> {
    const supabase = this.supabaseService.getClient();

    const existing = await this.getTeamById(userId, teamId);
    if (!existing) {
      throw new NotFoundException(`Team ${teamId} not found`);
    }

    const { error } = await supabase
      .from(this.tableName)
      .delete()
      .eq('user_id', userId)
      .eq('id', teamId);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return { deleted: true };
  }
}
