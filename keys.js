// src/routes/keys.js  –  /create-api-key, /revoke-api-key
'use strict';

const express  = require('express');
const { body, param } = require('express-validator');

const db                     = require('../db');
const { requireJWT }         = require('../middleware/auth');
const { handleValidationErrors } = require('../middleware/validate');
const { generateApiKey, hashApiKey } = require('../utils/crypto');
const logger                 = require('../utils/logger');

const router = express.Router();

const MAX_KEYS_PER_USER = 5;

// ── POST /create-api-key ─────────────────────────────────────────
router.post(
  '/create-api-key',
  requireJWT,
  [
    body('label')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 64 })
      .withMessage('Label must be ≤ 64 characters'),
  ],
  handleValidationErrors,
  async (req, res) => {
    const userId = req.user.id;

    try {
      // Enforce per-user key cap
      const { rows: existing } = await db.query(
        'SELECT COUNT(*) AS cnt FROM api_keys WHERE user_id = $1 AND NOT is_revoked',
        [userId]
      );
      if (parseInt(existing[0].cnt, 10) >= MAX_KEYS_PER_USER) {
        return res.status(409).json({
          error: `Maximum of ${MAX_KEYS_PER_USER} active API keys per account`,
        });
      }

      const { raw, prefix } = generateApiKey();
      const keyHash         = hashApiKey(raw);
      const label           = req.body.label?.trim() || null;

      await db.query(
        `INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
         VALUES ($1, $2, $3, $4)`,
        [userId, keyHash, prefix, label]
      );

      logger.info('API key created', { userId, prefix });

      // Raw key shown ONCE – never stored in plaintext
      res.status(201).json({
        message: 'API key created – save this now, it will not be shown again',
        api_key: raw,
        prefix,
        label,
      });
    } catch (err) {
      logger.error('Create API key error', { error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── DELETE /revoke-api-key/:prefix ──────────────────────────────
router.delete(
  '/revoke-api-key/:prefix',
  requireJWT,
  [
    param('prefix')
      .isAlphanumeric()
      .isLength({ min: 8, max: 8 })
      .withMessage('Invalid key prefix'),
  ],
  handleValidationErrors,
  async (req, res) => {
    const userId = req.user.id;
    const { prefix } = req.params;

    try {
      const { rowCount } = await db.query(
        `UPDATE api_keys
         SET is_revoked = TRUE
         WHERE user_id = $1 AND key_prefix = $2 AND NOT is_revoked`,
        [userId, prefix]
      );

      if (rowCount === 0) {
        return res.status(404).json({ error: 'API key not found or already revoked' });
      }

      logger.info('API key revoked', { userId, prefix });
      res.json({ message: 'API key revoked' });
    } catch (err) {
      logger.error('Revoke API key error', { error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── GET /api-keys  (list current user's keys) ───────────────────
router.get('/api-keys', requireJWT, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT key_prefix, label, is_revoked, last_used_at, created_at
       FROM api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ keys: rows });
  } catch (err) {
    logger.error('List keys error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
