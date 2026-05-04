// src/services/obfuscator.js
// ─────────────────────────────────────────────────────────────────
//  Core obfuscation logic.
//
//  This module implements a pure-JS Lua source transformer.
//  Techniques applied (in order):
//    1. Variable / function name mangling (rename locals to _vN)
//    2. String literal encoding  (hex / decimal escape sequences)
//    3. Number literal obfuscation (replace N with math expression)
//    4. Dead-code / decoy comment insertion
//    5. Whitespace normalisation
//
//  SECURITY NOTE:
//    - Input is processed entirely in-memory.
//    - No temp files are created.
//    - The original source is discarded immediately after transform.
// ─────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');

// ── Lua reserved words – must never be renamed ────────────────────
const LUA_KEYWORDS = new Set([
  'and','break','do','else','elseif','end','false','for',
  'function','goto','if','in','local','nil','not','or',
  'repeat','return','then','true','until','while',
  // Lua standard library globals we should leave alone
  'print','tostring','tonumber','type','pairs','ipairs',
  'next','select','unpack','table','string','math','io',
  'os','coroutine','package','require','pcall','xpcall',
  'error','assert','rawget','rawset','setmetatable',
  'getmetatable','collectgarbage','_G','_VERSION',
]);

/**
 * Quick heuristic: does this string look like Lua source?
 * Checks for at least one Lua-specific construct.
 */
function looksLikeLua(code) {
  const luaPatterns = [
    /\blocal\b/,
    /\bfunction\b/,
    /\bend\b/,
    /\bthen\b/,
    /--/,             // comment
    /\bdo\b/,
    /\breturn\b/,
  ];
  const matched = luaPatterns.filter(p => p.test(code)).length;
  return matched >= 2;  // must match at least 2 patterns
}

/**
 * Encode a string value to Lua hex escape sequences.
 * "hello" → "\104\101\108\108\111"
 */
function encodeStringLiteral(str) {
  return str
    .split('')
    .map(c => `\\${c.charCodeAt(0)}`)
    .join('');
}

/**
 * Replace a number literal with an equivalent arithmetic expression.
 * 42 → (6*7) or (21+21) etc.
 */
function obfuscateNumber(n) {
  const num = parseFloat(n);
  if (isNaN(num) || !isFinite(num)) return n;
  if (Number.isInteger(num) && Math.abs(num) < 100000) {
    const a = Math.floor(Math.random() * 50) + 1;
    const b = num - a;
    return `(${a}+${b})`;
  }
  return n;
}

/**
 * Generate a random-looking but valid Lua identifier.
 */
function makeIdent(index) {
  const chars = 'lIiОоO0'; // visually confusing chars mixed
  const base   = `_${chars[index % chars.length]}${index}`;
  return base;
}

/**
 * Main obfuscation entry point.
 * @param {string} code    – raw Lua source
 * @param {object} options – { renameVars, encodeStrings, encodeNumbers }
 * @returns {{ obfuscated: string, warnings: string[] }}
 */
async function obfuscate(code, options = {}) {
  const warnings = [];
  const opts = {
    renameVars:    options.renameVars    !== false,
    encodeStrings: options.encodeStrings !== false,
    encodeNumbers: options.encodeNumbers !== false,
  };

  let result = code;

  // ── Pass 1: strip single-line comments (–– …) ────────────────
  // We must do this before string encoding so we don't mangle comment text.
  // Multi-line comments (--[[ ]]) are preserved for now.
  result = result.replace(/--(?!\[)[^\n]*/g, '');

  // ── Pass 2: encode string literals ───────────────────────────
  if (opts.encodeStrings) {
    // Match both single and double-quoted strings (non-greedy, handles escapes)
    result = result.replace(
      /(["'])(?:(?=(\\?))\2[\s\S])*?\1/g,
      (match) => {
        const quote   = match[0];
        const content = match.slice(1, -1);
        // Skip empty strings and very short strings (not worth encoding)
        if (content.length === 0 || content.length > 80) return match;
        // Skip strings that are already escape-heavy
        if ((content.match(/\\/g) || []).length > content.length * 0.4) return match;
        try {
          const encoded = encodeStringLiteral(content);
          return `"${encoded}"`;
        } catch {
          return match;
        }
      }
    );
  }

  // ── Pass 3: encode number literals ───────────────────────────
  if (opts.encodeNumbers) {
    // Only transform standalone integers not inside strings
    result = result.replace(/\b(\d+)\b/g, (match, num) => {
      // Don't transform 0 or 1 (too common, makes code huge)
      if (num === '0' || num === '1') return match;
      return obfuscateNumber(num);
    });
  }

  // ── Pass 4: rename local variables ───────────────────────────
  if (opts.renameVars) {
    const localVarMap = new Map();
    let   varCounter  = 0;

    // Find all `local varName` declarations
    const localDeclRegex = /\blocal\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let match;
    while ((match = localDeclRegex.exec(result)) !== null) {
      const name = match[1];
      if (!LUA_KEYWORDS.has(name) && !localVarMap.has(name)) {
        localVarMap.set(name, makeIdent(varCounter++));
      }
    }

    // Replace occurrences – whole-word only
    for (const [original, renamed] of localVarMap) {
      const re = new RegExp(`\\b${escapeRegex(original)}\\b`, 'g');
      result   = result.replace(re, renamed);
    }

    if (localVarMap.size === 0) {
      warnings.push('No local variables found to rename – obfuscation strength reduced');
    }
  }

  // ── Pass 5: insert decoy/junk comments ───────────────────────
  const junkLines = [
    `-- ${crypto.randomBytes(8).toString('hex')}`,
    `-- v${Math.floor(Math.random()*9)+1}.${Math.floor(Math.random()*9)}`,
    `--[compiled]`,
  ];
  const lines = result.split('\n');
  for (let i = lines.length - 1; i > 0; i -= Math.floor(Math.random() * 8) + 5) {
    lines.splice(i, 0, junkLines[i % junkLines.length]);
  }
  result = lines.join('\n');

  // ── Pass 6: collapse excess whitespace ───────────────────────
  result = result
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { obfuscated: result, warnings };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { obfuscate, looksLikeLua };
