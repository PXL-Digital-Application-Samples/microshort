import { describe, it, expect } from 'vitest';
import { hashIp, escapeHtml } from './utils.js';

describe('hashIp', () => {
  it('produces a 64-character hex string', () => {
    const hash = hashIp('192.168.1.1', 'test-salt');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same ip and salt', () => {
    const ip = '10.0.0.1';
    const salt = 'my-salt';
    expect(hashIp(ip, salt)).toBe(hashIp(ip, salt));
  });

  it('produces different hashes for different IPs with the same salt', () => {
    const salt = 'same-salt';
    expect(hashIp('1.2.3.4', salt)).not.toBe(hashIp('5.6.7.8', salt));
  });

  it('produces different hashes for the same IP with different salts', () => {
    const ip = '1.2.3.4';
    expect(hashIp(ip, 'salt-a')).not.toBe(hashIp(ip, 'salt-b'));
  });

  it('handles null/undefined ip by falling back to 0.0.0.0', () => {
    const salt = 'test';
    expect(hashIp(null, salt)).toBe(hashIp('0.0.0.0', salt));
    expect(hashIp(undefined, salt)).toBe(hashIp('0.0.0.0', salt));
  });

  it('never returns the raw IP in the hash output', () => {
    const ip = '192.168.100.200';
    const hash = hashIp(ip, 'salt');
    expect(hash).not.toContain(ip);
  });
});

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"test"')).toBe('&quot;test&quot;');
    expect(escapeHtml("'test'")).toBe('&#39;test&#39;');
  });

  it('leaves normal characters intact', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });
});
