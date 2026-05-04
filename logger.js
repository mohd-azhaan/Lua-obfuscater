// src/utils/logger.js
'use strict';

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const { combine, timestamp, errors, json, colorize, simple } = format;

const isProduction = process.env.NODE_ENV === 'production';

const logger = createLogger({
  level: isProduction ? 'info' : 'debug',
  format: combine(
    timestamp(),
    errors({ stack: true }),
    json()
  ),
  defaultMeta: { service: 'luaobf-api' },
  transports: [
    // Always log to stdout (Railway captures this)
    new transports.Console({
      format: isProduction
        ? combine(timestamp(), json())
        : combine(colorize(), simple()),
    }),
    // Rotate daily log files in production
    ...(isProduction
      ? [
          new transports.DailyRotateFile({
            filename: 'logs/error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxFiles: '14d',
            zippedArchive: true,
          }),
          new transports.DailyRotateFile({
            filename: 'logs/combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '7d',
            zippedArchive: true,
          }),
        ]
      : []),
  ],
});

module.exports = logger;
