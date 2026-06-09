import { createHash } from 'crypto';

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function isValidApiKeyFormat(key) {
  return typeof key === 'string' && key.startsWith('msh_') && key.length === 36;
}
