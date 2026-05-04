// src/routes/auth.js  –  /signup, /login
'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const { body } = require('express-validator');

const db                     = require('../db');
const { authLimiter }        = require('../middleware/rateLimiter');
const { handleValidationErrors } = require('../middleware/validate');
const logger                 = require('../utils/logger');

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// ── Validation chains ────────────────────────────────────────────
const signupValidators = [
  body('email')
    .isEmail().withMessage('Valid email required')
    .normalizeEmail()
    .isLength({ max: 254 }),
  body('password')
    .isLength({ min: 8, max: 128 }).withMessage('Password must be 8–128 characters')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain a number'),
];

const loginValidators = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 1, max: 128 }),
];

// ── POST /signup ─────────────────────────────────────────────────
router.post(
  '/signup',
  authLimiter,
  signupValidators,
  handleValidationErrors,
  async (req, res) => {
    const { email, password } = req.body;

    try {
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        // Don't reveal whether the account exists – use a generic message
        return res.status(409).json({ error: 'Registration failed – check your details' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const { rows } = await db.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2)
         RETURNING id, email, plan, created_at`,
        [email, passwordHash]
      );

      const user  = rows[0];
      const token = signJwt(user.id);

      logger.info('User registered', { userId: user.id });

      res.status(201).json({
        message: 'Account created',
        token,
        user: { id: user.id, email: user.email, plan: user.plan },
      });
    } catch (err) {
      logger.error('Signup error', { error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── POST /login ──────────────────────────────────────────────────
router.post(
  '/login',
  authLimiter,
  loginValidators,
  handleValidationErrors,
  async (req, res) => {
    const { email, password } = req.body;

    try {
      const { rows } = await db.query(
        'SELECT id, email, password_hash, plan, is_banned FROM users WHERE email = $1',
        [email]
      );

      // Constant-time: always run bcrypt even if user not found (prevents timing attack)
      const DUMMY_HASH = '$2b$12$invalidhashplaceholderXXXXXXXXXXXXXXXXXXXXXXXXX';
      const hash       = rows[0]?.password_hash ?? DUMMY_HASH;
      const valid      = await bcrypt.compare(password, hash);

      if (rows.length === 0 || !valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = rows[0];

      if (user.is_banned) {
        return res.status(403).json({ error: 'Account suspended' });
      }

      const token = signJwt(user.id);

      logger.info('User logged in', { userId: user.id });

      res.json({
        token,
        user: { id: user.id, email: user.email, plan: user.plan },
      });
    } catch (err) {
      logger.error('Login error', { error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── Helpers ──────────────────────────────────────────────────────
function signJwt(userId) {
  return jwt.sign(
    { sub: userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d', algorithm: 'HS256' }
  );
}

module.exports = router;
