'use strict';

// Load .env in non-production environments
if (process.env.NODE_ENV !== 'production') {
  try {
    require('fs').readFileSync('.env', 'utf8')
      .split('\n')
      .filter(line => line && !line.startsWith('#'))
      .forEach(line => {
        const [key, ...rest] = line.split('=');
        if (key && rest.length && !process.env[key.trim()]) {
          process.env[key.trim()] = rest.join('=').trim();
        }
      });
  } catch { /* .env optional */ }
}

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};

const optionalInt = (key, fallback) =>
  parseInt(process.env[key] || String(fallback), 10);

module.exports = {
  NODE_ENV:               process.env.NODE_ENV || 'development',
  PORT:                   optionalInt('PORT', 3001),
  IS_PROD:                process.env.NODE_ENV === 'production',

  // Database
  DB_HOST:                required('DB_HOST'),
  DB_PORT:                optionalInt('DB_PORT', 5432),
  DB_NAME:                required('DB_NAME'),
  DB_USER:                required('DB_USER'),
  DB_PASSWORD:            required('DB_PASSWORD'),
  DB_POOL_MAX:            optionalInt('DB_POOL_MAX', 20),

  // JWT
  JWT_ACCESS_SECRET:      required('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET:     required('JWT_REFRESH_SECRET'),
  JWT_ACCESS_EXPIRES_IN:  process.env.JWT_ACCESS_EXPIRES_IN  || '1h',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '8h',

  // Security
  BCRYPT_ROUNDS:          optionalInt('BCRYPT_ROUNDS', 12),
  CORS_ORIGIN:            process.env.CORS_ORIGIN || 'http://localhost:3000',

  // Rate limiting
  RATE_LIMIT_WINDOW_MS:   optionalInt('RATE_LIMIT_WINDOW_MS', 900_000),
  RATE_LIMIT_MAX:         optionalInt('RATE_LIMIT_MAX', 200),
  AUTH_RATE_LIMIT_MAX:    optionalInt('AUTH_RATE_LIMIT_MAX', 10),

  // Error monitoring (optional — no-op if unset)
  SENTRY_DSN:             process.env.SENTRY_DSN || '',

  // Ooredoo Credentials

  AHLA_PHONE_NUMBER:      process.env.AHLA_PHONE_NUMBER,
  AHLA_PASSWORD:          process.env.AHLA_PASSWORD,
  AHLA_CODE_PIN:          process.env.AHLA_CODE_PIN,
};
