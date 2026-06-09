import { cleanEnv, str } from 'envalid';

export const env = cleanEnv(process.env, {
  SERVICE_TOKEN:         str({ desc: 'Shared service-to-service token for analytics calls' }),
  IP_HASH_SALT:          str({ desc: 'Salt for SHA-256(client_ip+salt) — changing this invalidates historical ip_hash values' }),
  URL_SERVICE_URL:       str({ default: 'http://url-service:3002' }),
  ANALYTICS_SERVICE_URL: str({ default: 'http://analytics-service:3005' }),
  REDIS_URL:             str({ default: 'redis://redis:6379' }),
  CONFIG_SERVICE_URL:   str({ default: 'http://config-service:3000' }),
  PORT:                  str({ default: '8080' }),
  CACHE_TTL_SECONDS:     str({ default: '300' }),
  ANALYTICS_BATCH_SIZE:  str({ default: '50' }),
  ANALYTICS_FLUSH_MS:    str({ default: '5000' }),
  LOG_LEVEL:             str({ default: 'info' }),
});
