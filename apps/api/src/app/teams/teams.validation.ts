import { BadRequestException } from '@nestjs/common';
import type {
  CreateTeamDto,
  StatSpread,
  TeamPokemonSlot,
  UpdateTeamDto,
} from './teams.types';

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

function ensureObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function ensureString(value: unknown, field: string, required = true): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }

  const trimmed = value.trim();
  if (required && !trimmed) {
    throw new BadRequestException(`${field} is required`);
  }

  return trimmed;
}

function ensureBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${field} must be a boolean`);
  }
  return value;
}

function ensureNumber(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new BadRequestException(`${field} must be a number`);
  }
  if (value < min || value > max) {
    throw new BadRequestException(`${field} must be between ${min} and ${max}`);
  }
  return Math.floor(value);
}

function normalizeSpread(
  value: unknown,
  field: string,
  min: number,
  max: number
): StatSpread | undefined {
  if (value == null) return undefined;
  const spreadObj = ensureObject(value, field);
  const spread: StatSpread = {};

  for (const statKey of Object.keys(spreadObj)) {
    if (!STAT_KEYS.includes(statKey as (typeof STAT_KEYS)[number])) {
      throw new BadRequestException(`${field}.${statKey} is not a valid stat`);
    }
  }

  for (const stat of STAT_KEYS) {
    const statValue = spreadObj[stat];
    if (statValue != null) {
      spread[stat] = ensureNumber(statValue, `${field}.${stat}`, min, max);
    }
  }

  return spread;
}

function normalizeMoves(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an array`);
  }
  if (value.length > 4) {
    throw new BadRequestException(`${field} can have at most 4 moves`);
  }

  return value.map((move, index) => ensureString(move, `${field}[${index}]`));
}

function normalizeSlot(value: unknown, index: number): TeamPokemonSlot {
  const slotObj = ensureObject(value, `slots[${index}]`);
  const moves = normalizeMoves(slotObj.moves ?? [], `slots[${index}].moves`);
  const slot =
    slotObj.slot == null
      ? index + 1
      : ensureNumber(slotObj.slot, `slots[${index}].slot`, 1, 6);

  return {
    slot,
    species: ensureString(slotObj.species, `slots[${index}].species`),
    nickname:
      slotObj.nickname == null
        ? undefined
        : ensureString(slotObj.nickname, `slots[${index}].nickname`, false),
    gender:
      slotObj.gender == null
        ? undefined
        : (ensureString(
            slotObj.gender,
            `slots[${index}].gender`,
            false
          ) as TeamPokemonSlot['gender']),
    level:
      slotObj.level == null
        ? undefined
        : ensureNumber(slotObj.level, `slots[${index}].level`, 1, 100),
    shiny:
      slotObj.shiny == null
        ? undefined
        : ensureBoolean(slotObj.shiny, `slots[${index}].shiny`),
    teraType:
      slotObj.teraType == null
        ? undefined
        : ensureString(slotObj.teraType, `slots[${index}].teraType`, false),
    nature:
      slotObj.nature == null
        ? undefined
        : ensureString(slotObj.nature, `slots[${index}].nature`, false),
    item:
      slotObj.item == null
        ? undefined
        : ensureString(slotObj.item, `slots[${index}].item`, false),
    ability:
      slotObj.ability == null
        ? undefined
        : ensureString(slotObj.ability, `slots[${index}].ability`, false),
    moves,
    evs: normalizeSpread(slotObj.evs, `slots[${index}].evs`, 0, 252),
    ivs: normalizeSpread(slotObj.ivs, `slots[${index}].ivs`, 0, 31),
  };
}

function normalizeSlots(value: unknown): TeamPokemonSlot[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException('slots must be an array');
  }
  if (value.length > 6) {
    throw new BadRequestException('A team can have at most 6 Pokemon');
  }

  return value.map((slot, index) => normalizeSlot(slot, index));
}

export function validateCreateTeamDto(body: unknown): CreateTeamDto {
  const payload = ensureObject(body, 'body');
  return {
    name: ensureString(payload.name, 'name'),
    format:
      payload.format == null ? undefined : ensureString(payload.format, 'format'),
    notes: payload.notes == null ? undefined : ensureString(payload.notes, 'notes'),
    slots: normalizeSlots(payload.slots),
  };
}

export function validateUpdateTeamDto(body: unknown): UpdateTeamDto {
  const payload = ensureObject(body, 'body');
  const dto: UpdateTeamDto = {};

  if ('name' in payload) {
    dto.name = ensureString(payload.name, 'name');
  }
  if ('format' in payload) {
    dto.format =
      payload.format == null ? undefined : ensureString(payload.format, 'format');
  }
  if ('notes' in payload) {
    dto.notes =
      payload.notes == null ? undefined : ensureString(payload.notes, 'notes');
  }
  if ('slots' in payload) {
    dto.slots = normalizeSlots(payload.slots);
  }

  return dto;
}
