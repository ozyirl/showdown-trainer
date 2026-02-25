const TIER_LEVEL_MAP: Record<string, number> = {
  AG: 71,
  UBER: 73,
  OU: 75,
  UUBL: 76,
  UU: 77,
  RUBL: 78,
  RU: 79,
  NUBL: 80,
  NU: 81,
  PUBL: 82,
  PU: 83,
  NFE: 84,
  LCUBER: 86,
  LCUBERS: 86,
  LC: 88,
};

const FALLBACK_TIER_LEVEL = 80;

export function normalizeTierKey(tier?: string | null): string | null {
  if (!tier) return null;

  const trimmed = tier.trim();
  if (!trimmed) return null;

  // Remove surrounding parentheses often used for lower-tier annotations like "(PU)".
  const unwrapped = trimmed.replace(/^\((.*)\)$/, '$1');
  const upper = unwrapped.toUpperCase();

  if (
    upper === 'UNRELEASED' ||
    upper === 'ILLEGAL' ||
    upper === 'CAP' ||
    upper === 'CAP NFE'
  ) {
    return null;
  }

  return upper.replace(/[^A-Z0-9]/g, '');
}

export function tierToAutoLevel(tier?: string | null): number {
  const key = normalizeTierKey(tier);
  if (!key) return FALLBACK_TIER_LEVEL;
  return TIER_LEVEL_MAP[key] ?? FALLBACK_TIER_LEVEL;
}

