// Text utilities: normalisation, typographic cleanup ("smartening"), linting,
// escaping and number formatting. Pure functions, no DOM, safe in Node + browser.

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 1 → "one", 21 → "twenty-one", 105 → "one hundred five". */
export function numberToWords(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n <= 0) return String(n);
  if (n >= 1000) return String(n);
  let out = '';
  if (n >= 100) {
    out = ONES[Math.floor(n / 100)] + ' hundred';
    n %= 100;
    if (!n) return out;
    out += ' ';
  }
  if (n < 20) return out + ONES[n];
  return out + TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
}

/** "twenty-one" → 21; returns null if not a number word. Handles 1–999. */
export function wordsToNumber(s) {
  const t = String(s).toLowerCase().trim();
  if (/^\d+$/.test(t)) return Number(t);
  for (let i = 1; i < 1000; i++) if (numberToWords(i) === t) return i;
  return null;
}

export function toRoman(n, lower = true) {
  n = Math.floor(n);
  if (n <= 0) return String(n);
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let r = '';
  for (const [v, s] of map) while (n >= v) { r += s; n -= v; }
  return lower ? r.toLowerCase() : r;
}

/** Escape for XML/XHTML text and attribute values. */
export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Characters that are invisible or illegal in XML and only cause trouble.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const ZERO_WIDTH_RE = /[​‌‍⁠﻿]/g;

/** Normalise line endings, Unicode form, and strip zero-width/control characters. */
export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/\t/g, ' ');
}

// Contexts after which a quote mark is an *opening* quote.
const OPEN_CTX = /[\s([{<—–\-/*_“‘]/;
// Words that begin with an elided letter take an apostrophe, not an opening single quote.
const ELISION_RE = /^(?:\d0s|\d\ds?\b|em\b|tis\b|twas\b|cause\b|til\b|n\b|round\b|bout\b|nother\b)/i;

/**
 * Convert straight quotes, double hyphens and triple dots to typographic forms.
 * Leaves markdown markers alone; backslash-escaped quotes stay straight.
 */
export function smartenText(s, { quotes = true, dashes = true, ellipses = true } = {}) {
  let t = String(s);
  if (dashes) t = t.replace(/(?<!-)---(?!-)/g, '—').replace(/(?<!-)--(?!-)/g, '—');
  if (ellipses) t = t.replace(/\.\.\./g, '…');
  if (!quotes) return t;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    const prev = i === 0 ? '' : t[i - 1];
    if ((c === '"' || c === "'") && prev === '\\') { out = out.slice(0, -1) + c; continue; }
    if (c === '"') {
      out += (i === 0 || OPEN_CTX.test(prev)) ? '“' : '”';
    } else if (c === "'") {
      const rest = t.slice(i + 1);
      if (i === 0 || OPEN_CTX.test(prev)) {
        out += ELISION_RE.test(rest) ? '’' : '‘';
      } else {
        out += '’';
      }
    } else {
      out += c;
    }
  }
  return out;
}

const LINT_RULES = [
  { code: 'straight-double-quote', re: /(?<!\\)"/g, msg: 'Straight double quote (") – should be “ or ”.', fix: 'quotes' },
  { code: 'straight-single-quote', re: /(?<!\\)'/g, msg: "Straight single quote (') – should be ‘ or ’.", fix: 'quotes' },
  { code: 'double-hyphen', re: /--/g, msg: 'Double hyphen (--) – should be an em dash (—).', fix: 'dashes' },
  { code: 'triple-dot', re: /\.\.\./g, msg: 'Three periods (...) – should be an ellipsis (…).', fix: 'ellipses' },
  { code: 'double-space', re: /\S {2,}\S/g, msg: 'Multiple spaces inside a paragraph.' },
  { code: 'html-markup', re: /<\/?[a-z][^>]*>/gi, msg: 'Looks like HTML markup – it will be printed literally.' },
  { code: 'backtick', re: /`/g, msg: 'Backtick (`) – probably meant an apostrophe.' },
];

/**
 * Lint the raw manuscript. Returns grouped warnings:
 * [{ code, message, count, lines:[n...], fixable, sample }]
 */
export function lintText(raw, { maxLines = 12 } = {}) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  const groups = new Map();
  const add = (code, message, line, sample, fix) => {
    let g = groups.get(code);
    if (!g) { g = { code, message, count: 0, lines: [], fixable: fix || null, sample }; groups.set(code, g); }
    g.count++;
    if (g.lines.length < maxLines && g.lines[g.lines.length - 1] !== line) g.lines.push(line);
  };
  const controls = String(raw ?? '').match(CONTROL_RE);
  if (controls) add('control-char', 'Invisible control characters (removed automatically).', 0, '', 'auto');
  const zw = String(raw ?? '').match(ZERO_WIDTH_RE);
  if (zw) add('zero-width', 'Zero-width/BOM characters (removed automatically).', 0, '', 'auto');
  text.split('\n').forEach((line, i) => {
    for (const r of LINT_RULES) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(line))) {
        const a = Math.max(0, m.index - 20);
        add(r.code, r.msg, i + 1, line.slice(a, m.index + 20).trim(), r.fix);
      }
    }
    if (/\s+$/.test(line) && line.trim()) add('trailing-space', 'Trailing whitespace (harmless, trimmed).', i + 1, '', 'auto');
  });
  return [...groups.values()];
}
