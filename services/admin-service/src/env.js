import { cleanEnv, str } from 'envalid';

export const env = cleanEnv(process.env, {
  SERVICE_TOKEN:       str({ desc: 'Shared service-to-service token for analytics calls' }),
  CONFIG_WRITE_TOKEN:  str({ desc: 'Token required to update domain via config-service' }),
  AUTH_SERVICE_URL:    str({ default: 'http://auth-service:3001' }),
  URL_SERVICE_URL:     str({ default: 'http://url-service:3002' }),
  CONFIG_SERVICE_URL:  str({ default: 'http://config-service:3000' }),
  ANALYTICS_SERVICE_URL: str({ default: 'http://analytics-service:3005' }),
  PORT:                str({ default: '3003' }),
  LOG_LEVEL:           str({ default: 'info' }),
});
