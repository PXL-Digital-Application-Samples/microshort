import { describe, it, expect } from 'vitest';
import { hashKey, isValidApiKeyFormat } from './utils.js';

describe('hashKey', () => {
  it('produces a 64-character hex string', () => {
    const hash = hashKey('msh_test123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(hashKey('same-key')).toBe(hashKey('same-key'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashKey('key-a')).not.toBe(hashKey('key-b'));
  });
});

describe('isValidApiKeyFormat', () => {
  it('accepts a properly formatted API key', () => {
    const key = 'msh_' + 'a'.repeat(32);
    expect(isValidApiKeyFormat(key)).toBe(true);
  });

  it('rejects a key without the msh_ prefix', () => {
    expect(isValidApiKeyFormat('sk_' + 'a'.repeat(32))).toBe(false);
  });

  it('rejects a key that is too short', () => {
    expect(isValidApiKeyFormat('msh_short')).toBe(false);
  });

  it('rejects a key that is too long', () => {
    expect(isValidApiKeyFormat('msh_' + 'a'.repeat(33))).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidApiKeyFormat(null)).toBe(false);
    expect(isValidApiKeyFormat(undefined)).toBe(false);
    expect(isValidApiKeyFormat(42)).toBe(false);
  });
});
