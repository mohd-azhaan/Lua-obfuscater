// src/utils/crypto.js  –  cryptographic helpers
'use strict';

const crypto = require('crypto');

/**
 * Generate a cryptographically secure API key.
 * Format: luaobf_<8-char prefix>_<40-char random hex>
 * Total length: ~56 chars – easy to distinguish, hard to brute-force.
 */
function generateApiKey() {
  const random = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  const prefix = random.slice(0, 8);
  const secret = random.slice(8);                        // 40 chars
  const raw    = `luaobf_${prefix}_${secret}`;
  return { raw, prefix };
}

/**
 * Hash an API key with SHA-256 for safe storage.
 * We do NOT use bcrypt here because:
 *   1. Keys are long random strings (entropy >> passwords).
 *   2. We need fast lookup on every request.
 *   3. SHA-256 of a 48-byte random value is computationally infeasible to reverse.
 */
function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Constant-time comparison to prevent timing attacks.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { generateApiKey, hashApiKey, safeCompare };
