import { createOpenAI } from '@ai-sdk/openai';
import { jsonrepair } from 'jsonrepair';
import {
  DEFAULT_KIMI_MODEL,
  getAiProvider,
  getAiClientConfig,
  getKimiRequestOptions,
} from './ai-provider';
import type { CopilotMode, CpuModelProfile } from './battle.service';

// Known reasoning model families / prefixes.
// Extend this list as new reasoning models ship.
const REASONING_MODEL_PATTERNS = [
  /^o[1-9]/, // o1, o3, o4-mini, etc.
  /^gpt-5/, // gpt-5-nano, gpt-5-mini, gpt-5, etc.
  /reasoning/i,
  /^kimi-k3/,
  /^kimi-k2\.7/,
  /thinking/i,
];

export function isReasoningModel(
  modelId: string,
  preferThinking = false
): boolean {
  return (
    REASONING_MODEL_PATTERNS.some((p) => p.test(modelId)) ||
    (modelId === DEFAULT_KIMI_MODEL && preferThinking)
  );
}

/**
 * Returns appropriate maxOutputTokens for the model type.
 * Reasoning models burn tokens on internal chain-of-thought,
 * so they need a much larger budget than standard models.
 */
export function getTokenBudget(
  modelId: string,
  intent: 'move' | 'action' | 'copilot',
  reasoning = isReasoningModel(modelId)
): number {
  // Leave enough space for Kimi's final JSON and user-visible rationale.
  if (getAiProvider() === 'kimi') {
    return reasoning ? 16384 : intent === 'copilot' ? 2048 : 512;
  }

  switch (intent) {
    case 'move':
      return reasoning ? 16384 : 80;
    case 'action':
      return reasoning ? 16384 : 120;
    case 'copilot':
      return reasoning ? 16384 : 400;
  }
}

export function resolveModelId(
  envVar: string,
  fallback = 'gpt-4.1-mini'
): string {
  if (getAiProvider() === 'kimi') {
    const kimiEnvVar = envVar.replace(/^OPENAI_/, 'KIMI_');
    return (
      process.env[kimiEnvVar]?.trim() ||
      process.env.KIMI_MODEL?.trim() ||
      (fallback.startsWith('kimi-') ? fallback : DEFAULT_KIMI_MODEL)
    );
  }
  return process.env[envVar] || fallback;
}

export function resolveCpuModelId(profile?: CpuModelProfile): string {
  if (profile === 'fast') {
    return resolveModelId('OPENAI_CPU_FAST_MODEL', 'gpt-4.1-nano-2025-04-14');
  }

  if (profile === 'reasoning') {
    return resolveModelId(
      'OPENAI_CPU_REASONING_MODEL',
      resolveModelId(
        'OPENAI_CPU_MODEL',
        getAiProvider() === 'kimi' ? 'kimi-k3' : 'gpt-5-nano-2025-08-07'
      )
    );
  }

  return resolveModelId('OPENAI_CPU_MODEL');
}

export function resolveCopilotModelId(mode?: CopilotMode): string {
  const effectiveMode = mode === 'off' ? undefined : mode ?? 'coach';

  if (effectiveMode === 'deep') {
    return resolveModelId(
      'OPENAI_COPILOT_DEEP_MODEL',
      resolveModelId('OPENAI_COPILOT_MODEL', resolveCpuModelId('reasoning'))
    );
  }

  if (effectiveMode === 'coach') {
    return resolveModelId(
      'OPENAI_COPILOT_COACH_MODEL',
      resolveModelId('OPENAI_COPILOT_MODEL', resolveCpuModelId('fast'))
    );
  }

  return resolveModelId(
    'OPENAI_COPILOT_MODEL',
    resolveModelId('OPENAI_CPU_MODEL')
  );
}

export function createModel(
  modelId: string,
  thinking = isReasoningModel(modelId)
) {
  const config = getAiClientConfig();
  if (getAiProvider() === 'kimi') {
    // The installed OpenAI adapter drops unknown provider options, so add
    // Kimi's thinking configuration at the transport boundary.
    return createOpenAI({
      ...config,
      fetch: (url, init) => {
        const body = JSON.parse(init?.body as string);
        return globalThis.fetch(url, {
          ...init,
          body: JSON.stringify({
            ...body,
            ...getKimiRequestOptions(modelId, thinking),
          }),
        });
      },
    }).chat(modelId);
  }
  return createOpenAI(config)(modelId);
}

/**
 * Extracts JSON from model output that may contain reasoning/thinking
 * tokens, markdown fences, or other wrapper text.
 */
export function extractJsonFromModelOutput(text: string): string {
  let cleaned = text;

  // Strip <think>...</think> or <reasoning>...</reasoning> wrapper blocks
  cleaned = cleaned.replace(
    /<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/gi,
    ''
  );

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1];
  }

  return cleaned.trim();
}

/**
 * Robust JSON object parser that handles reasoning model output.
 * Tries direct parse, then extracts from wrapped output, then
 * falls back to greedy brace matching.
 */
export function parseJsonFromModelOutput(
  text: string
): Record<string, unknown> | null {
  const cleaned = extractJsonFromModelOutput(text);

  // Direct parse
  const direct = safeJsonParse(cleaned);
  if (direct) return direct;

  // Try jsonrepair on the cleaned text
  const repaired = tryRepairJson(cleaned);
  if (repaired) return repaired;

  // Greedy brace match on the cleaned text
  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    const parsed = safeJsonParse(braceMatch[0]);
    if (parsed) return parsed;

    const repairedBrace = tryRepairJson(braceMatch[0]);
    if (repairedBrace) return repairedBrace;
  }

  // Last resort: try brace match on the original (pre-cleaned) text
  const originalBraceMatch = text.match(/\{[\s\S]*\}/);
  if (originalBraceMatch) {
    const parsed = safeJsonParse(originalBraceMatch[0]);
    if (parsed) return parsed;

    return tryRepairJson(originalBraceMatch[0]);
  }

  return null;
}

function tryRepairJson(text: string): Record<string, unknown> | null {
  try {
    const fixed = jsonrepair(text);
    return safeJsonParse(fixed);
  } catch {
    return null;
  }
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
