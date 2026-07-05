import { createHash } from 'crypto';

export const PASSWORD_MIN_LENGTH = 8;
// Pragmatic email shape check (something@something.tld); full RFC 5322
// validation is deliberately out of scope.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function isValidApiKeyFormat(key) {
  return typeof key === 'string' && key.startsWith('msh_') && key.length === 36;
}

export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_PATTERN.test(email);
}

export function isValidPassword(password) {
  return typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH;
}
