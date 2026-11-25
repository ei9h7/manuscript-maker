// Manuscript format
// -----------------
//   ## 1|Chapter Title|Subtitle   → starts a chapter (number|title|subtitle; number & subtitle optional)
//   one line                       → one paragraph (blank lines are ignored)
//   [!callout] text                → callout box
//   *italic*  _italic_  **bold**   → inline emphasis
//   \*  \_  \\  \#  \[             → literal characters
// Everything else is body text.

import { normalizeText, smartenText, wordsToNumber } from './text.js';

const HEADING_RE = /^#{1,2}\s+(.+)$/;
const CALLOUT_RE = /^\[!callout\]\s*/i;

/**
 * @returns {{ chapters: Array, stray: Array, warnings: Array }}
 *   chapter = { num, title, subtitle, line, blocks: [{ type: 'p'|'callout', text, line }] }
 */
export function parseManuscript(raw, opts = {}) {
  const { smartQuotes = true, smartDashes = true, ellipses = true, calloutPattern = '', calloutBoldLead = true } = opts;
  const smart = (s) => smartenText(s, { quotes: smartQuotes, dashes: smartDashes, ellipses });
  const warnings = [];
  let calloutRe = null;
  if (calloutPattern && calloutPattern.trim()) {
    try { calloutRe = new RegExp(calloutPattern, 'u'); }
    catch (e) { warnings.push({ code: 'bad-callout-pattern', message: `Callout pattern is not a valid regular expression: ${e.message}` }); }
  }

  const lines = normalizeText(raw).split('\n');
  const chapters = [];
  const stray = [];
  let cur = null;

  lines.forEach((rawLine, i) => {
    const line = i + 1;
    const t = rawLine.trim();
    if (!t) return;
    const h = HEADING_RE.exec(t);
    if (h) {
      const parts = h[1].split('|').map((s) => s.trim());
      let num = null, title, subtitle = '';
      const n = parts.length >= 2 ? wordsToNumber(parts[0]) : null;
      if (n != null) { num = n; title = parts[1]; subtitle = parts.slice(2).join(' | '); }
      else if (parts.length >= 2 && parts[0] === '') { title = parts[1]; subtitle = parts.slice(2).join(' | '); }
      else { title = parts[0]; subtitle = parts.slice(1).join(' | '); }
      if (!title) warnings.push({ code: 'empty-title', message: `Chapter heading without a title (line ${line}).`, line });
      cur = { num, title: smart(title || ''), subtitle: smart(subtitle || ''), line, blocks: [] };
      chapters.push(cur);
      return;
    }
    let text = t;
    let type = 'p';
    if (CALLOUT_RE.test(text)) { type = 'callout'; text = text.replace(CALLOUT_RE, ''); }
    else if (calloutRe && calloutRe.test(text)) type = 'callout';
    // A leading backslash escapes a would-be heading / callout marker.
    if (/^\\[#[]/.test(text)) text = text.slice(1);
    if (!text) return;
    // "Label: text" at the start of a callout → bold label.
    if (type === 'callout' && calloutBoldLead && !/^\*\*/.test(text)) {
      text = text.replace(/^([^:*_\\]{1,48}):(\s)/, '**$1:**$2');
    }
    const block = { type, text: smart(text), line };
    if (cur) cur.blocks.push(block); else stray.push(block);
  });

  if (stray.length) {
    warnings.push({ code: 'text-before-first-chapter', line: stray[0].line,
      message: `${stray.length} paragraph(s) before the first "## n|Title" heading – they are not included in the book.` });
  }
  if (!chapters.length) warnings.push({ code: 'no-chapters', message: 'No chapters found. Start each chapter with a line like: ## 1|Chapter Title|Subtitle' });

  // Auto-number chapters without a number; flag duplicates / gaps.
  let prev = 0;
  const seen = new Set();
  for (const ch of chapters) {
    if (ch.num == null) ch.num = prev + 1;
    if (seen.has(ch.num)) warnings.push({ code: 'duplicate-chapter-number', line: ch.line, message: `Chapter number ${ch.num} is used more than once (line ${ch.line}).` });
    else if (ch.num !== prev + 1) warnings.push({ code: 'chapter-number-gap', line: ch.line, message: `Chapter ${ch.num} follows chapter ${prev} (line ${ch.line}).` });
    seen.add(ch.num);
    prev = ch.num;
    if (!ch.blocks.length) warnings.push({ code: 'empty-chapter', line: ch.line, message: `Chapter ${ch.num} “${ch.title}” has no text.` });
    for (const b of ch.blocks) {
      const runs = parseInline(b.text);
      if (runs.unbalanced) warnings.push({ code: 'unbalanced-emphasis', line: b.line, message: `Unmatched * or _ on line ${b.line} – printed literally.` });
    }
  }
  return { chapters, stray, warnings };
}

// Placeholders for escaped characters (Unicode private-use area).
const ESC = { '*': '', '_': '', '\\': '', '#': '', '[': '', '|': '' };
const UNESC = Object.fromEntries(Object.entries(ESC).map(([k, v]) => [v, k]));
const unescape = (s) => s.replace(/[-]/g, (c) => UNESC[c]);

const INLINE_RE = /\*\*(?=\S)(.+?)(?<=\S)\*\*|\*(?=\S)(.+?)(?<=\S)\*|(?<![\p{L}\p{N}])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}])/u;

/**
 * Split a paragraph into styled runs: [{ text, italic, bold }].
 * The returned array has a non-enumerable `unbalanced` flag if stray markers remain.
 */
export function parseInline(text) {
  const src = String(text).replace(/\\([*_\\#[|])/g, (_, c) => ESC[c]);
  const runs = [];
  const walk = (s, italic, bold) => {
    while (s) {
      const m = INLINE_RE.exec(s);
      if (!m) { runs.push({ text: s, italic, bold }); return; }
      if (m.index) runs.push({ text: s.slice(0, m.index), italic, bold });
      if (m[1] != null) walk(m[1], italic, true);
      else walk(m[2] ?? m[3], !italic, bold);
      s = s.slice(m.index + m[0].length);
    }
  };
  walk(src, false, false);
  // Merge neighbours with identical style, restore escapes.
  const merged = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.italic === r.italic && last.bold === r.bold) last.text += r.text;
    else merged.push({ ...r });
  }
  const unbalanced = merged.some((r) => /[*]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/u.test(r.text));
  for (const r of merged) r.text = unescape(r.text);
  Object.defineProperty(merged, 'unbalanced', { value: unbalanced });
  return merged;
}

/** Plain text of a paragraph (markers removed). */
export function plainText(text) {
  return parseInline(text).map((r) => r.text).join('');
}

/** Serialise a parsed book back to manuscript format (used by importers). */
export function serializeManuscript(chapters) {
  const clean = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/').trim();
  const out = [];
  chapters.forEach((ch, i) => {
    if (i) out.push('');
    const head = [ch.num ?? i + 1, clean(ch.title)];
    if (ch.subtitle) head.push(clean(ch.subtitle));
    out.push('## ' + head.join('|'));
    for (const b of ch.blocks) {
      let t = String(b.text).replace(/\s*\n\s*/g, ' ').trim();
      if (!t) continue;
      if (b.type !== 'callout' && /^(#|\[!callout\])/i.test(t)) t = '\\' + t;
      out.push(b.type === 'callout' ? `[!callout] ${t}` : t);
    }
  });
  return out.join('\n') + '\n';
}
