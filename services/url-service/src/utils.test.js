import { describe, it, expect } from 'vitest';
import { isValidSlug, SLUG_MAX_LEN } from './utils.js';

describe('isValidSlug', () => {
  it('accepts alphanumeric slugs', () => {
    expect(isValidSlug('abc123')).toBe(true);
    expect(isValidSlug('ABC')).toBe(true);
    expect(isValidSlug('a1B2c3')).toBe(true);
  });

  it('accepts slugs with hyphens and underscores', () => {
    expect(isValidSlug('my-link')).toBe(true);
    expect(isValidSlug('my_link')).toBe(true);
    expect(isValidSlug('my-link_2024')).toBe(true);
  });

  it('rejects slugs with spaces or special characters', () => {
    expect(isValidSlug('my link')).toBe(false);
    expect(isValidSlug('hello!')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
    expect(isValidSlug('a.b')).toBe(false);
  });

  it('accepts a slug at the maximum length', () => {
    expect(isValidSlug('a'.repeat(SLUG_MAX_LEN))).toBe(true);
  });

  it('rejects a slug exceeding the maximum length', () => {
    expect(isValidSlug('a'.repeat(SLUG_MAX_LEN + 1))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidSlug('')).toBe(false);
  });

  it('rejects reserved slugs', () => {
    expect(isValidSlug('health')).toBe(false);
    expect(isValidSlug('ready')).toBe(false);
    expect(isValidSlug('metrics')).toBe(false);
    expect(isValidSlug('healthy')).toBe(true);
  });
});
