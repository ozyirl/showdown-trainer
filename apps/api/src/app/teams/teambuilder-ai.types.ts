import type { TeamPokemonSlot } from './teams.types';

export type TeambuilderChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type TeambuilderChatRequest = {
  messages: TeambuilderChatMessage[];
  currentSlots?: TeamPokemonSlot[];
  format?: string;
};

export type TeambuilderChatResponse = {
  message: string;
  slotUpdates: TeamPokemonSlot[];
};
