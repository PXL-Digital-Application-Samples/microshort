import { cleanEnv, str, port } from 'envalid';

export const env = cleanEnv(process.env, {
  SERVICE_TOKEN:       str({ default: '', desc: 'Legacy shared service-to-service token (deprecated, optional)' }),
  CONFIG_WRITE_TOKEN:  str({ desc: 'Token required to update domain via config-service' }),
  ADMIN_SERVICE_TOKEN: str({ desc: 'Token used by admin-service to call internal service endpoints' }),
  AUTH_SERVICE_URL:    str({ default: 'http://auth-service:3001' }),
  URL_SERVICE_URL:     str({ default: 'http://url-service:3002' }),
  CONFIG_SERVICE_URL:  str({ default: 'http://config-service:3000' }),
  ANALYTICS_SERVICE_URL: str({ default: 'http://analytics-service:3005' }),
  PORT:                port({ default: 3003 }),
  LOG_LEVEL:           str({ default: 'info' }),
  ALLOWED_ORIGINS:     str({ default: '*' }),
  TRUST_PROXY:         str({ default: '1', desc: 'Express trust proxy setting: hop count, true/false, or subnet' }),
});

// Refuse to boot with placeholder secrets outside local development.
if (process.env.NODE_ENV === 'production') {
  const placeholders = ['CONFIG_WRITE_TOKEN', 'ADMIN_SERVICE_TOKEN']
    .filter(name => env[name].includes('change-me'));
  if (placeholders.length > 0) {
    throw new Error(
      `Refusing to start in production with placeholder secrets: ${placeholders.join(', ')}`
    );
  }
}
