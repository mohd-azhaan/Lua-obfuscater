// src/services/abuse.js  –  basic abuse detection
'use strict';

const db     = require('../db');
const logger = require('../utils/logger');

// Thresholds
const MAX_REQUESTS_PER_MINUTE_PER_IP = 20;
const MAX_ABUSE_FLAGS_BEFORE_BAN     = 10;
const MAX_CODE_SIZE_SPIKE_RATIO      = 5; // alert if 5x normal size

/**
 * Check a request for signs of abuse before processing.
 * Returns { flagged: boolean, reason: string | null }
 */
async function checkRequest({ userId, ip, codeSize, userAgent }) {
  try {
    // ── 1. Check requests-per-minute per IP ─────────────────────
    const { rows: recentRows } = await db.query(
      `SELECT COUNT(*) AS cnt
       FROM usage_log
       WHERE ip_address = $1
         AND created_at > NOW() - INTERVAL '1 minute'`,
      [ip]
    );
    const recentCount = parseInt(recentRows[0]?.cnt ?? 0, 10);
    if (recentCount >= MAX_REQUESTS_PER_MINUTE_PER_IP) {
      await flagAbuse(userId, ip, 'IP rate spike: too many requests in 1 minute');
      return { flagged: true, reason: 'Request rate too high' };
    }

    // ── 2. Check accumulated abuse flags ─────────────────────────
    const { rows: flagRows } = await db.query(
      `SELECT COUNT(*) AS cnt
       FROM abuse_flags
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    const flagCount = parseInt(flagRows[0]?.cnt ?? 0, 10);
    if (flagCount >= MAX_ABUSE_FLAGS_BEFORE_BAN) {
      // Auto-ban
      await db.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [userId]);
      logger.warn('User auto-banned due to repeated abuse flags', { userId });
      return { flagged: true, reason: 'Account suspended due to abuse' };
    }

    // ── 3. Headless / bot user-agent check ───────────────────────
    const suspiciousUAs = ['python-requests', 'Go-http-client', 'libcurl', 'wget', 'scrapy'];
    const ua = (userAgent || '').toLowerCase();
    if (suspiciousUAs.some(s => ua.includes(s.toLowerCase()))) {
      // Warn but don't block – scripted API usage is legitimate
      logger.info('Scripted UA detected', { userId, ip, ua });
    }

    // ── 4. Code size spike detection ────────────────────────────
    const { rows: avgRows } = await db.query(
      `SELECT AVG(code_size_bytes) AS avg_size
       FROM usage_log
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '7 days'`,
      [userId]
    );
    const avgSize = parseFloat(avgRows[0]?.avg_size ?? 0);
    if (avgSize > 0 && codeSize > avgSize * MAX_CODE_SIZE_SPIKE_RATIO && codeSize > 50_000) {
      await flagAbuse(userId, ip, `Code size spike: ${codeSize} bytes vs avg ${Math.round(avgSize)}`);
      // Log but don't block – could be legitimate large file
      logger.warn('Code size spike flagged', { userId, codeSize, avgSize });
    }

    return { flagged: false, reason: null };
  } catch (err) {
    logger.error('Abuse check error', { error: err.message });
    // Fail open – don't block legitimate traffic on internal errors
    return { flagged: false, reason: null };
  }
}

async function flagAbuse(userId, ip, reason) {
  try {
    await db.query(
      'INSERT INTO abuse_flags (user_id, ip_address, reason) VALUES ($1, $2, $3)',
      [userId, ip, reason]
    );
  } catch (err) {
    logger.error('Could not write abuse flag', { error: err.message });
  }
}

module.exports = { checkRequest };
