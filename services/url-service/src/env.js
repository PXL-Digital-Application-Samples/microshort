import { cleanEnv, str, port, num } from 'envalid';

export const env = cleanEnv(process.env, {
  DB_PASSWORD:              str({ desc: 'MySQL password for url_db' }),
  SERVICE_TOKEN:            str({ default: '', desc: 'Legacy shared service-to-service token (deprecated, optional)' }),
  DB_HOST:                  str({ default: 'url-db' }),
  DB_PORT:                  port({ default: 3306 }),
  DB_NAME:                  str({ default: 'urlshort' }),
  DB_USER:                  str({ default: 'urluser' }),
  REDIS_URL:                str({ default: 'redis://redis:6379' }),
  AUTH_SERVICE_URL:         str({ default: 'http://auth-service:3001' }),
  CONFIG_SERVICE_URL:       str({ default: 'http://config-service:3000' }),
  ANALYTICS_SERVICE_URL:    str({ default: 'http://analytics-service:3005' }),
  CLICK_SYNC_INTERVAL_MS:   num({ default: 60_000 }),
  URL_RATE_LIMIT_WINDOW_MS: num({ default: 60 * 1000 }),
  URL_RATE_LIMIT_MAX:       num({ default: 30 }),
  PORT:                     port({ default: 3002 }),
  LOG_LEVEL:                str({ default: 'info' }),
  ALLOWED_ORIGINS:          str({ default: '*' }),
  URL_SERVICE_TOKEN:        str({ desc: 'Token used by url-service to call analytics' }),
  ADMIN_SERVICE_TOKEN:      str({ desc: 'Token required for admin calls to url-service' }),
  REDIRECT_SERVICE_TOKEN:   str({ desc: 'Token redirect-service presents on slug lookups' }),
  TRUST_PROXY:              str({ default: '1', desc: 'Express trust proxy setting: hop count, true/false, or subnet' }),
});

// Refuse to boot with placeholder secrets outside local development.
if (process.env.NODE_ENV === 'production') {
  const placeholders = ['DB_PASSWORD', 'URL_SERVICE_TOKEN', 'ADMIN_SERVICE_TOKEN', 'REDIRECT_SERVICE_TOKEN']
    .filter(name => env[name].includes('change-me'));
  if (placeholders.length > 0) {
    throw new Error(
      `Refusing to start in production with placeholder secrets: ${placeholders.join(', ')}`
    );
  }
}
