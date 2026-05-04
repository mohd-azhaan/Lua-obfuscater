// src/middleware/auth.js  –  JWT authentication middleware
'use strict';

const jwt    = require('jsonwebtoken');
const db     = require('../db');
const logger = require('../utils/logger');

/**
 * requireJWT  –  validates Bearer token, attaches req.user
 */
async function requireJWT(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    const token = header.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { rows } = await db.query(
      'SELECT id, email, plan, plan_expires_at, is_banned FROM users WHERE id = $1',
      [payload.sub]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = rows[0];

    if (user.is_banned) {
      return res.status(403).json({ error: 'Account suspended' });
    }

    // Downgrade expired paid plans automatically
    if (user.plan !== 'free' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
      await db.query(
        "UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = $1",
        [user.id]
      );
      user.plan = 'free';
      user.plan_expires_at = null;
    }

    req.user = user;
    next();
  } catch (err) {
    logger.error('JWT middleware error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { requireJWT };
