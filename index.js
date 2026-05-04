// src/db/index.js  –  PostgreSQL connection pool
'use strict';

const { Pool } = require('pg');
const logger   = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }   // Railway / Heroku-style TLS
    : false,
  max:             20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error', { error: err.message });
});

/**
 * Run a query with automatic client checkout / release.
 * @param {string} text   – parameterised SQL
 * @param {Array}  params – query parameters
 */
async function query(text, params) {
  const start = Date.now();
  const res   = await pool.query(text, params);
  const dur   = Date.now() - start;
  if (dur > 500) {
    logger.warn('Slow query detected', { duration: dur, query: text.slice(0, 80) });
  }
  return res;
}

/**
 * Obtain a dedicated client for transactions.
 * Caller MUST call client.release() in a finally block.
 */
async function getClient() {
  return pool.connect();
}

module.exports = { query, getClient, pool };
