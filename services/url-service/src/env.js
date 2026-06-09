import { cleanEnv, str } from 'envalid';

export const env = cleanEnv(process.env, {
  DB_PASSWORD:              str({ desc: 'MySQL password for url_db' }),
  SERVICE_TOKEN:            str({ desc: 'Shared service-to-service token for analytics calls' }),
  DB_HOST:                  str({ default: 'url-db' }),
  DB_PORT:                  str({ default: '3306' }),
  DB_NAME:                  str({ default: 'urlshort' }),
  DB_USER:                  str({ default: 'urluser' }),
  REDIS_URL:                str({ default: 'redis://redis:6379' }),
  AUTH_SERVICE_URL:         str({ default: 'http://auth-service:3001' }),
  CONFIG_SERVICE_URL:       str({ default: 'http://config-service:3000' }),
  ANALYTICS_SERVICE_URL:    str({ default: 'http://analytics-service:3005' }),
  CLICK_SYNC_INTERVAL_MS:   str({ default: '60000' }),
  URL_RATE_LIMIT_WINDOW_MS: str({ default: String(60 * 1000) }),
  URL_RATE_LIMIT_MAX:       str({ default: '30' }),
  PORT:                     str({ default: '3002' }),
  LOG_LEVEL:                str({ default: 'info' }),
});
