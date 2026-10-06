'use strict';

// Sentry must be initialised before any other module that we want to instrument.
const Sentry    = require('./config/sentry');
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp  = require('pino-http');
const env       = require('./config/env');
const { pool, healthCheck } = require('./config/db');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const logger    = require('./utils/logger');

// Route imports
const authRoutes     = require('./routes/authRoutes');
const usersRoutes    = require('./routes/usersRoutes');
const offersRoutes   = require('./routes/offersRoutes');
const productsRoutes = require('./routes/productsRoutes');
const sessionsRoutes = require('./routes/sessionsRoutes');
const salesRoutes    = require('./routes/salesRoutes');
const reportsRoutes  = require('./routes/reportsRoutes');
const financesRoutes = require('./routes/financesRoutes');
const stockRoutes    = require('./routes/stockRoutes');
const customersRoutes = require('./routes/customersRoutes');
const advancesRoutes = require('./routes/advancesRoutes');
const expensesRoutes = require('./routes/expensesRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const storeRoutes = require('./routes/storeRoutes');
const discountRoutes = require('./routes/discountRoutes');
const registerLedgerRoutes = require('./routes/registerLedgerRoutes');
const customerValidationRoutes = require('./routes/customerValidationRoutes');
// const { set } = require('fast-check');

const app = express();
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',  
  process.env.CORS_ORIGIN 
];

// ─── Trust Proxy (required behind Nginx/load balancer for correct IP) ────────
app.set('trust proxy', 1);

// ─── Request Logging ─────────────────────────────────────────────────────────
app.use(pinoHttp({ logger }));

// ─── Security & Utility Middleware ───────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '100kb' }));

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', globalLimiter);

// Stricter rate limiter for auth endpoints (login, refresh).
// `skipSuccessfulRequests: true` means only failed logins (4xx/5xx) count
// against the quota, which is what you actually want to stop brute-force
// attacks without punishing legitimate users who log in repeatedly.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.AUTH_RATE_LIMIT_MAX,
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});
app.use('/api/auth', authLimiter);

// ─── Health Check Route ──────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const dbTime = await healthCheck();
    res.status(200).json({ status: 'ok', databaseTime: dbTime });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Database connection failed' });
  }
});

// ─── Mount API Routes ────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/offers', offersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/reports', reportsRoutes);
// IMPORTANT: mount the expenses sub-router BEFORE `/api/finances` so the
// admin-only blanket middleware on `financesRoutes` does not block cashiers
// from `/api/finances/expenses` (cashiers need POST/GET-me/void here).
app.use('/api/finances/expenses', expensesRoutes);
app.use('/api/finances', financesRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/advances', advancesRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/discounts', discountRoutes);
app.use('/api/register-ledger', registerLedgerRoutes);
app.use('/api/customer-validation', customerValidationRoutes);

// ─── 404 & Global Error Handling ─────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Refresh Token Cleanup (runs every 6 hours) ─────────────────────────────
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM refresh_tokens WHERE expires_at < NOW() - INTERVAL '7 days'`
    );
    if (rowCount > 0) {
      logger.info({ deletedTokens: rowCount }, 'Expired refresh tokens cleaned up.');
    }
  } catch (err) {
    logger.error({ err }, 'Refresh token cleanup failed.');
  }
}, CLEANUP_INTERVAL_MS);

// ─── Server Initialization with DB Retry ─────────────────────────────────────
const startServer = async (retries = 5) => {
  // Retry DB connection (useful when DB is slow to start in containers)
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      logger.info('[DB] Connected to PostgreSQL successfully.');
      break;
    } catch (err) {
      if (i === retries - 1) {
        logger.fatal({ err }, '[SERVER] Failed to connect to database after retries.');
        process.exit(1);
      }
      logger.warn(`[DB] Connection attempt ${i + 1}/${retries} failed. Retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const server = app.listen(env.PORT, () => {
    logger.info(`[SERVER] Running in ${env.NODE_ENV} mode on port ${env.PORT}`);
  });

  // ─── Graceful Shutdown ───────────────────────────────────────────────────
  const shutdown = (signal) => {
    logger.info(`[SERVER] ${signal} received. Shutting down gracefully...`);
    server.close(() => {
      pool.end().then(() => {
        logger.info('[SERVER] All connections closed. Exiting.');
        process.exit(0);
      });
    });
    // Force kill after 10 seconds if graceful shutdown hangs
    setTimeout(() => {
      logger.error('[SERVER] Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

startServer();
