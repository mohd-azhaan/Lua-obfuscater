// src/routes/obfuscate.js  –  POST /obfuscate
// ─────────────────────────────────────────────────────────────────
// SECURITY GUARANTEES:
//   • Input code is NEVER written to disk or logged
//   • Only metadata (size, duration) is stored in usage_log
//   • Input size is hard-capped at MAX_CODE_BYTES
//   • Basic structural validation rejects non-Lua payloads
// ─────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const { body } = require('express-validator');

const db                     = require('../db');
const { requireApiKey }      = require('../middleware/apiKey');
const { handleValidationErrors } = require('../middleware/validate');
const obfuscatorService      = require('../services/obfuscator');
const abuseService           = require('../services/abuse');
const logger                 = require('../utils/logger');

const router = express.Router();

const MAX_CODE_BYTES = parseInt(process.env.MAX_CODE_BYTES || '131072', 10); // 128 KB

// ── POST /obfuscate ──────────────────────────────────────────────
router.post(
  '/obfuscate',
  requireApiKey,
  [
    body('code')
      .isString().withMessage('code must be a string')
      .notEmpty().withMessage('code must not be empty')
      .custom((value) => {
        const byteLen = Buffer.byteLength(value, 'utf8');
        if (byteLen > MAX_CODE_BYTES) {
          throw new Error(`Code exceeds maximum size of ${MAX_CODE_BYTES} bytes`);
        }
        return true;
      }),
    body('options')
      .optional()
      .isObject().withMessage('options must be an object'),
  ],
  handleValidationErrors,
  async (req, res) => {
    const { code, options = {} } = req.body;
    const startTime = Date.now();
    const codeSize  = Buffer.byteLength(code, 'utf8');

    try {
      // ── Abuse detection (pre-obfuscation) ───────────────────────
      const abuseCheck = await abuseService.checkRequest({
        userId:    req.user.id,
        ip:        req.ip,
        codeSize,
        userAgent: req.headers['user-agent'],
      });

      if (abuseCheck.flagged) {
        logger.warn('Abuse flag triggered', {
          userId: req.user.id,
          ip: req.ip,
          reason: abuseCheck.reason,
        });
        return res.status(403).json({
          error: 'Request rejected by abuse filter',
          reason: abuseCheck.reason,
        });
      }

      // ── Validate it looks like Lua ───────────────────────────────
      if (!obfuscatorService.looksLikeLua(code)) {
        return res.status(422).json({
          error: 'Payload does not appear to be valid Lua source code',
        });
      }

      // ── Obfuscate ────────────────────────────────────────────────
      const { obfuscated, warnings } = await obfuscatorService.obfuscate(code, options);

      const duration = Date.now() - startTime;

      // ── Increment daily counter + write usage log (no code stored) ─
      await Promise.all([
        db.query(
          `INSERT INTO daily_usage (user_id, usage_date, request_count)
             VALUES ($1, CURRENT_DATE, 1)
           ON CONFLICT (user_id, usage_date)
             DO UPDATE SET request_count = daily_usage.request_count + 1`,
          [req.user.id]
        ),
        db.query(
          `INSERT INTO usage_log (user_id, api_key_id, ip_address, code_size_bytes, duration_ms)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user.id, req.apiKey.id, req.ip, codeSize, duration]
        ),
      ]);

      // ── Set rate-limit info headers ──────────────────────────────
      res.set({
        'X-RateLimit-Limit':     String(req.apiKey.limit),
        'X-RateLimit-Used':      String(req.apiKey.used + 1),
        'X-RateLimit-Remaining': String(Math.max(0, req.apiKey.limit - req.apiKey.used - 1)),
        'X-RateLimit-Reset':     'midnight UTC',
      });

      res.json({
        obfuscated,
        meta: {
          input_bytes:  codeSize,
          output_bytes: Buffer.byteLength(obfuscated, 'utf8'),
          duration_ms:  duration,
          warnings:     warnings.length > 0 ? warnings : undefined,
          requests_remaining: Math.max(0, req.apiKey.limit - req.apiKey.used - 1),
        },
      });
    } catch (err) {
      logger.error('Obfuscation error', {
        userId: req.user.id,
        error: err.message,
        // Never log the code itself
      });

      if (err.code === 'OBFUSCATION_FAILED') {
        return res.status(422).json({ error: err.message });
      }

      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
