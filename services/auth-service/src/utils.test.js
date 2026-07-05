import { describe, it, expect } from 'vitest';
import { hashKey, isValidApiKeyFormat, isValidEmail, isValidPassword } from './utils.js';

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

describe('isValidEmail', () => {
  it('accepts a normal email address', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('a.b+tag@sub.domain.co')).toBe(true);
  });

  it('rejects strings without an @ or domain dot', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('user@localhost')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
  });

  it('rejects emails with whitespace', () => {
    expect(isValidEmail('user name@example.com')).toBe(false);
  });

  it('rejects non-string values and overlong addresses', () => {
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('isValidPassword', () => {
  it('accepts a password of at least 8 characters', () => {
    expect(isValidPassword('12345678')).toBe(true);
    expect(isValidPassword('Test-pass-123!')).toBe(true);
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(isValidPassword('x')).toBe(false);
    expect(isValidPassword('1234567')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidPassword(null)).toBe(false);
    expect(isValidPassword(12345678)).toBe(false);
  });
});
