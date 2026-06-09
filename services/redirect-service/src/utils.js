import { createHash } from 'crypto';

export function hashIp(ip, salt) {
  return createHash('sha256').update((ip || '0.0.0.0') + salt).digest('hex');
}
