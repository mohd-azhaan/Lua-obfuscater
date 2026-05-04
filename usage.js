// src/routes/usage.js  –  GET /usage
'use strict';

const express = require('express');
const db      = require('../db');
const { requireJWT }    = require('../middleware/auth');
const { getDailyLimit } = require('../middleware/apiKey');
const logger  = require('../utils/logger');

const router = express.Router();

// ── GET /usage ───────────────────────────────────────────────────
router.get('/usage', requireJWT, async (req, res) => {
  const userId = req.user.id;

  try {
    const [todayRes, historyRes, keysRes] = await Promise.all([
      // Today's count
      db.query(
        `SELECT COALESCE(request_count, 0) AS today
         FROM daily_usage
         WHERE user_id = $1 AND usage_date = CURRENT_DATE`,
        [userId]
      ),
      // Last 30 days breakdown
      db.query(
        `SELECT usage_date, request_count
         FROM daily_usage
         WHERE user_id = $1 AND usage_date >= CURRENT_DATE - INTERVAL '30 days'
         ORDER BY usage_date DESC`,
        [userId]
      ),
      // Active keys summary
      db.query(
        `SELECT key_prefix, label, last_used_at, created_at
         FROM api_keys
         WHERE user_id = $1 AND NOT is_revoked
         ORDER BY created_at DESC`,
        [userId]
      ),
    ]);

    const todayCount  = parseInt(todayRes.rows[0]?.today ?? 0, 10);
    const dailyLimit  = getDailyLimit(req.user.plan);

    res.json({
      plan:               req.user.plan,
      daily_limit:        dailyLimit,
      used_today:         todayCount,
      remaining_today:    Math.max(0, dailyLimit - todayCount),
      resets_at:          'midnight UTC',
      history_30d:        historyRes.rows,
      active_keys:        keysRes.rows,
    });
  } catch (err) {
    logger.error('Usage route error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
