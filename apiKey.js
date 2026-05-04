// src/middleware/apiKey.js  –  API key validation + daily limit check
'use strict';

const db          = require('../db');
const { hashApiKey } = require('../utils/crypto');
const logger      = require('../utils/logger');

const FREE_DAILY  = parseInt(process.env.FREE_DAILY_LIMIT  || '10',  10);
const BASIC_DAILY = parseInt(process.env.BASIC_DAILY_LIMIT || '400', 10);

function getDailyLimit(plan) {
  return plan === 'basic' ? BASIC_DAILY : FREE_DAILY;
}

/**
 * requireApiKey  –  validates X-API-Key header, checks daily usage quota.
 * Attaches req.user, req.apiKey to downstream handlers.
 */
async function requireApiKey(req, res, next) {
  const rawKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!rawKey || typeof rawKey !== 'string' || rawKey.length < 20) {
    return res.status(401).json({ error: 'Missing or invalid X-API-Key header' });
  }

  // Sanitise – only allow expected characters to prevent injection
  if (!/^[a-zA-Z0-9_-]+$/.test(rawKey)) {
    return res.status(401).json({ error: 'Malformed API key' });
  }

  const keyHash = hashApiKey(rawKey);

  try {
    // Single JOIN query – key + user in one round-trip
    const { rows } = await db.query(
      `SELECT
         ak.id           AS key_id,
         ak.is_revoked,
         u.id            AS user_id,
         u.email,
         u.plan,
         u.plan_expires_at,
         u.is_banned
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.key_hash = $1`,
      [keyHash]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const row = rows[0];

    if (row.is_revoked) {
      return res.status(401).json({ error: 'API key has been revoked' });
    }

    if (row.is_banned) {
      return res.status(403).json({ error: 'Account suspended' });
    }

    // Downgrade expired paid plans on the fly
    let plan = row.plan;
    if (plan !== 'free' && row.plan_expires_at && new Date(row.plan_expires_at) < new Date()) {
      await db.query(
        "UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = $1",
        [row.user_id]
      );
      plan = 'free';
    }

    const dailyLimit = getDailyLimit(plan);

    // Check + upsert daily counter atomically
    const counterResult = await db.query(
      `INSERT INTO daily_usage (user_id, usage_date, request_count)
         VALUES ($1, CURRENT_DATE, 0)
       ON CONFLICT (user_id, usage_date) DO NOTHING;
       SELECT request_count FROM daily_usage
         WHERE user_id = $1 AND usage_date = CURRENT_DATE`,
      [row.user_id]
    );

    const usageRow = await db.query(
      'SELECT request_count FROM daily_usage WHERE user_id = $1 AND usage_date = CURRENT_DATE',
      [row.user_id]
    );

    const currentCount = usageRow.rows[0]?.request_count ?? 0;

    if (currentCount >= dailyLimit) {
      return res.status(429).json({
        error: 'Daily request limit reached',
        limit: dailyLimit,
        plan,
        resets_at: 'midnight UTC',
      });
    }

    // Update last_used_at (non-blocking)
    db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.key_id])
      .catch(e => logger.warn('last_used_at update failed', { error: e.message }));

    req.user = {
      id:   row.user_id,
      email: row.email,
      plan,
    };
    req.apiKey = {
      id:    row.key_id,
      limit: dailyLimit,
      used:  currentCount,
    };

    next();
  } catch (err) {
    logger.error('API key middleware error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { requireApiKey, getDailyLimit };
