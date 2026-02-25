import { normalizeTierKey, tierToAutoLevel } from './tier-auto-level';

describe('tierToAutoLevel', () => {
  it('maps common tiers to configured auto levels', () => {
    expect(tierToAutoLevel('OU')).toBe(75);
    expect(tierToAutoLevel('Uber')).toBe(73);
    expect(tierToAutoLevel('AG')).toBe(71);
    expect(tierToAutoLevel('LC')).toBe(88);
  });

  it('normalizes wrapped and mixed-case tiers', () => {
    expect(normalizeTierKey('(PU)')).toBe('PU');
    expect(tierToAutoLevel('(pu)')).toBe(83);
    expect(tierToAutoLevel('LC Uber')).toBe(86);
  });

  it('falls back for unknown or unsupported tiers', () => {
    expect(tierToAutoLevel('Unknown')).toBe(80);
    expect(tierToAutoLevel('Illegal')).toBe(80);
    expect(tierToAutoLevel(undefined)).toBe(80);
  });
});

