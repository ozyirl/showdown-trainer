export type StatSpread = Partial<
  Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>
>;

export type TeamPokemonSlot = {
  slot: number;
  species: string;
  nickname?: string;
  gender?: 'M' | 'F' | 'N';
  level?: number;
  shiny?: boolean;
  teraType?: string;
  nature?: string;
  item?: string;
  ability?: string;
  moves: string[];
  evs?: StatSpread;
  ivs?: StatSpread;
};

export type TeamRecord = {
  id: string;
  user_id: string;
  name: string;
  format: string | null;
  notes: string | null;
  slots: TeamPokemonSlot[];
  created_at: string;
  updated_at: string;
};

export type CreateTeamDto = {
  name: string;
  format?: string;
  notes?: string;
  slots?: TeamPokemonSlot[];
};

export type UpdateTeamDto = Partial<CreateTeamDto>;
