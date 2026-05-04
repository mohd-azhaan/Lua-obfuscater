// src/server.js  –  Express application bootstrap
'use strict';

require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');

const logger            = require('./utils/logger');
const { globalIpLimiter } = require('./middleware/rateLimiter');
const db                = require('./db');

// ── Route modules ─────────────────────────────────────────────────
const authRoutes      = require('./routes/auth');
const keyRoutes       = require('./routes/keys');
const obfuscateRoutes = require('./routes/obfuscate');
const usageRoutes     = require('./routes/usage');
const billingRoutes   = require('./routes/billing');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Security headers ──────────────────────────────────────────────
app.set('trust proxy', 1);  // Railway / reverse proxy
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc:  ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// ── CORS ──────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow Postman / server-to-server (no origin header)
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Used', 'X-RateLimit-Remaining'],
  maxAge: 86400,
}));

// ── Compression ───────────────────────────────────────────────────
app.use(compression());

// ── Body parsing ──────────────────────────────────────────────────
// /webhook needs raw body for Stripe signature verification → skip it here
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  express.json({ limit: '256kb' })(req, res, next);
});

// ── Global IP rate limiter ────────────────────────────────────────
app.use(globalIpLimiter);

// ── Request logger ────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.debug('Incoming request', {
    method: req.method,
    path:   req.path,
    ip:     req.ip,
  });
  next();
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'disconnected' });
  }
});

// ── Routes ────────────────────────────────────────────────────────
app.use('/', authRoutes);
app.use('/', keyRoutes);
app.use('/', obfuscateRoutes);
app.use('/', usageRoutes);
app.use('/', billingRoutes);

// ── 404 handler ───────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ──────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ──────────────────────────────────────────────────
async function start() {
  try {
    await db.query('SELECT 1');
    logger.info('Database connection verified');
  } catch (err) {
    logger.error('Cannot connect to database on startup', { error: err.message });
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`LuaObf API listening on port ${PORT}`, {
      env:  process.env.NODE_ENV,
      port: PORT,
    });
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received – shutting down gracefully');
  await db.pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

start();

module.exports = app; // for tests
