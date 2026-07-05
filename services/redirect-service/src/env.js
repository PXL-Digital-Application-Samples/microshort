import { cleanEnv, str, port, num } from 'envalid';

export const env = cleanEnv(process.env, {
  SERVICE_TOKEN:          str({ default: '', desc: 'Legacy shared service-to-service token (deprecated, optional)' }),
  REDIRECT_SERVICE_TOKEN: str({ desc: 'Token used by redirect-service to call analytics and url-service' }),
  IP_HASH_SALT:           str({ desc: 'Salt for SHA-256(client_ip+salt) — changing this invalidates historical ip_hash values' }),
  URL_SERVICE_URL:        str({ default: 'http://url-service:3002' }),
  ANALYTICS_SERVICE_URL:  str({ default: 'http://analytics-service:3005' }),
  REDIS_URL:              str({ default: 'redis://redis:6379' }),
  CONFIG_SERVICE_URL:     str({ default: 'http://config-service:3000' }),
  PORT:                   port({ default: 8080 }),
  CACHE_TTL_SECONDS:      num({ default: 300 }),
  ANALYTICS_BATCH_SIZE:   num({ default: 50 }),
  ANALYTICS_FLUSH_MS:     num({ default: 5000 }),
  ANALYTICS_MAX_BUFFER:   num({ default: 10_000, desc: 'Max buffered click events while analytics-service is unreachable; oldest are dropped beyond this' }),
  LOG_LEVEL:              str({ default: 'info' }),
  TRUST_PROXY:            str({ default: '1', desc: 'Express trust proxy setting: hop count, true/false, or subnet' }),
});

// Refuse to boot with placeholder secrets outside local development.
if (process.env.NODE_ENV === 'production') {
  const placeholders = ['REDIRECT_SERVICE_TOKEN', 'IP_HASH_SALT']
    .filter(name => env[name].includes('change-me'));
  if (placeholders.length > 0) {
    throw new Error(
      `Refusing to start in production with placeholder secrets: ${placeholders.join(', ')}`
    );
  }
}
