// Greedy line breaker with hyphen/dash break points, soft hyphens and a
// hard character split as a last resort. Measurement is delegated to the
// caller (jsPDF getTextWidth), so it is font- and size-accurate.

const SOFT_HYPHEN = '­';
const NBSP = ' ';
const HYPHENS = new Set(['-', '‐', '‑']);
const DASHES = new Set(['—', '–']);
const isLetter = (c) => /[\p{L}\p{N}]/u.test(c);

export const styleKey = (r) => (r.bold && r.italic ? 'bolditalic' : r.bold ? 'bold' : r.italic ? 'italic' : 'normal');

/**
 * Runs → words. A word is { cps: [codepoint strings], sty: [style per codepoint] }.
 * Free-standing dashes ("word — word") get `glue`, so a line never starts with one.
 */
export function tokenize(runs) {
  const words = [];
  let cur = null;
  for (const r of runs) {
    const st = styleKey(r);
    for (const c of Array.from(r.text)) {
      if (/\s/.test(c) && c !== NBSP) {
        if (cur) { words.push(cur); cur = null; }
        continue;
      }
      if (!cur) cur = { cps: [], sty: [] };
      cur.cps.push(c);
      cur.sty.push(st);
    }
  }
  if (cur) words.push(cur);
  // A free-standing dash may not start a line: mark it so the breaker
  // carries the previous word along with it.
  const out = words;
  for (let i = 1; i < out.length; i++) if (out[i].cps.every((c) => DASHES.has(c))) out[i].glue = true;
  return out;
}

/** Allowed break positions inside a word: index i means "break after cps[i]". */
function breakPoints(word, { minBefore = 2, minAfter = 2 } = {}) {
  const pts = [];
  const { cps } = word;
  for (let i = 0; i < cps.length - 1; i++) {
    const c = cps[i];
    if (c === SOFT_HYPHEN || HYPHENS.has(c) || DASHES.has(c) || c === '/') {
      const before = cps.slice(0, i).filter(isLetter).length;
      const after = cps.slice(i + 1).filter(isLetter).length;
      const lim = DASHES.has(c) || c === '/' ? 1 : null;
      if (before >= (lim ?? minBefore) && after >= (lim ?? minAfter)) pts.push(i);
    }
  }
  return pts;
}

/** Group a slice of a word into styled segments, dropping soft hyphens. */
function segments(word, from, to, trailingHyphen = false) {
  const segs = [];
  for (let i = from; i < to; i++) {
    let c = word.cps[i];
    if (c === SOFT_HYPHEN) continue;
    if (c === NBSP) c = ' ';
    const st = word.sty[i];
    const last = segs[segs.length - 1];
    if (last && last.style === st) last.text += c;
    else segs.push({ text: c, style: st });
  }
  if (trailingHyphen) {
    const st = word.sty[Math.max(from, to - 1)] || 'normal';
    const last = segs[segs.length - 1];
    if (last && last.style === st) last.text += '-';
    else segs.push({ text: '-', style: st });
  }
  return segs;
}

const slice = (w, a, b) => ({ cps: w.cps.slice(a, b), sty: w.sty.slice(a, b) });

/**
 * Break styled runs into lines.
 * @param {Array} runs        [{text, italic, bold}]
 * @param {number} width      line width (pt)
 * @param {object} o
 *   measure(text, style) → width in pt
 *   firstIndent            indent of the first line
 *   hyphenBreaks           allow breaking at hyphens/dashes/soft hyphens
 * @returns lines: [{ items:[{segs, width, space}], width, indent, last }]
 */
export function breakLines(runs, width, o) {
  const { measure, firstIndent = 0, hyphenBreaks = false, noDashStart = false } = o;
  const space = measure(' ', 'normal');
  const segW = (segs) => segs.reduce((a, s) => a + measure(s.text, s.style), 0);
  const words = tokenize(runs);
  const lines = [];
  let line = { items: [], width: 0, indent: firstIndent };
  const avail = () => width - line.indent;
  const push = () => { lines.push(line); line = { items: [], width: 0, indent: 0 }; };
  const add = (segs, w, gap) => {
    line.items.push({ segs, width: w, space: gap > 0 });
    line.width += gap + w;
  };

  for (const word of words) {
    // Never start a line with a free-standing dash: if it doesn't fit, take the
    // previous word down to the next line with it.
    if (noDashStart && word.glue && line.items.length > 1) {
      const w = segW(segments(word, 0, word.cps.length));
      if (line.width + space + w > avail() + 0.01) {
        const prev = line.items.pop();
        line.width -= prev.width + (prev.space ? space : 0);
        push();
        add(prev.segs, prev.width, 0);
      }
    }
    let rest = word;
    while (rest && rest.cps.length) {
      const gap = line.items.length ? space : 0;
      const room = avail() - line.width - gap;
      const whole = segments(rest, 0, rest.cps.length);
      const w = segW(whole);
      if (w <= room + 0.01) { add(whole, w, gap); rest = null; break; }

      // Try the longest prefix that ends at an allowed break point.
      let placed = false;
      if (hyphenBreaks || !line.items.length) { // on an empty line, split at hyphens before hard-splitting
        const pts = breakPoints(rest);
        for (let k = pts.length - 1; k >= 0; k--) {
          const i = pts[k];
          const soft = rest.cps[i] === SOFT_HYPHEN;
          const segs = segments(rest, 0, i + 1, soft);
          const pw = segW(segs);
          if (pw <= room + 0.01) {
            add(segs, pw, gap);
            rest = slice(rest, i + 1, rest.cps.length);
            push();
            placed = true;
            break;
          }
        }
      }
      if (placed) continue;
      if (line.items.length) { push(); continue; }

      // Empty line and nothing fits: hard split by characters.
      let n = rest.cps.length - 1;
      while (n > 1 && segW(segments(rest, 0, n, true)) > room) n--;
      const segs = segments(rest, 0, n, true);
      add(segs, segW(segs), 0);
      rest = slice(rest, n, rest.cps.length);
      push();
    }
  }
  if (line.items.length || !lines.length) lines.push(line);
  lines[lines.length - 1].last = true;
  return lines;
}

/**
 * Compute x positions for each item on a line.
 * align: 'justify' | 'left' | 'center' | 'right'
 */
export function placeLine(line, x, width, align, space) {
  const avail = width - line.indent;
  const gaps = line.items.filter((it, i) => i > 0 && it.space).length;
  let extra = 0;
  let start = x + line.indent;
  if (align === 'justify' && !line.last && gaps > 0) extra = (avail - line.width) / gaps;
  else if (align === 'center') start += (avail - line.width) / 2;
  else if (align === 'right') start += avail - line.width;
  const pos = [];
  let cx = start;
  line.items.forEach((it, i) => {
    if (i > 0 && it.space) cx += space + extra;
    pos.push(cx);
    cx += it.width;
  });
  return pos;
}
