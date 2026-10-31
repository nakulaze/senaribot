import pino from 'pino';
import { getConfig } from '@/config/env.js';

const config = getConfig();

const redactOptions = {
  paths: [
    'phone',
    'jid',
    'sessionId',
    'token',
    'secret',
    'key',
    'apiKey',
    'APINEX_API_KEY',
    'authorization',
    'headers.authorization',
    '*.apiKey',
    '*.APINEX_API_KEY',
    '*.authorization',
    '*.headers.authorization',
  ],
  censor: '[REDACTED]',
};

export const logger = pino(
  {
    level: config.SENARIBOT_LOG_LEVEL,
    transport:
      config.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: false,
              translateTime: 'SYS:standard',
            },
          }
        : undefined,
    redact: redactOptions,
  },
  pino.destination({
    sync: process.env.NODE_ENV === 'development',
  }),
);

export const childLogger = (namespace: string) =>
  logger.child({ name: 'senaribot', module: namespace });
