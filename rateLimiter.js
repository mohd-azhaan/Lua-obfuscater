// src/middleware/rateLimiter.js  –  express-rate-limit configurations
'use strict';

const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10); // 15 min
const MAX_IP    = parseInt(process.env.RATE_LIMIT_MAX_PER_IP || '100', 10);

/**
 * Standard response when a rate limit is hit
 */
function rateLimitHandler(req, res, _next, options) {
  logger.warn('Rate limit triggered', {
    ip: req.ip,
    path: req.path,
    limit: options.max,
  });
  res.status(429).json({
    error: 'Too many requests – slow down',
    retry_after_ms: Math.ceil(options.windowMs),
  });
}

/**
 * Global per-IP limiter – applied to all routes.
 * Prevents enumeration / scanner abuse before any auth runs.
 */
const globalIpLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_IP,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: rateLimitHandler,
  skip: (req) => req.path === '/health',
});

/**
 * Strict limiter for auth endpoints (login / signup).
 * Prevents credential stuffing and brute-force attacks.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: rateLimitHandler,
  message: { error: 'Too many auth attempts – try again in 15 minutes' },
});

/**
 * Webhook limiter – Stripe only, but we still protect the endpoint.
 */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: rateLimitHandler,
});

module.exports = { globalIpLimiter, authLimiter, webhookLimiter };
