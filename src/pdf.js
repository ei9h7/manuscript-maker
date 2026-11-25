// Print PDF builder (jsPDF, pt units).
//
// Two passes: layout produces a display list per page (so the table of
// contents can be filled with page numbers that are only known after the
// chapters are laid out), then the display list is rendered into jsPDF.

import { breakLines, placeLine } from './linebreak.js';
import { parseInline } from './parser.js';
import { numberToWords, toRoman } from './text.js';
import { registerFonts, resolveFamily, winAnsiSafe, BUILTIN, FAMILIES } from './fonts.js';
import { parseFrontMatter, fill, splitPraise } from './frontmatter.js';
import { scaleSettings } from './settings.js';

const PT = 72;
const EPS = 0.01;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Combine a role's base style with an inline run style (italic toggles, bold adds). */
function compose(base, run) {
  const bi = base.includes('italic'), bb = base.includes('bold');
  const ri = run.includes('italic'), rb = run.includes('bold');
  const it = bi !== ri, bo = bb || rb;
  return bo && it ? 'bolditalic' : bo ? 'bold' : it ? 'italic' : 'normal';
}

export function buildPdf(book, S0, { jsPDF, fontData }) {
  const S = scaleSettings(S0);
  const K = S.scaled || 1;           // large-print factor for the fixed sizes below
  const W = S.trim.width * PT;
  const H = S.trim.height * PT;
  const doc = new jsPDF({ unit: 'pt', format: [W, H], orientation: W > H ? 'landscape' : 'portrait', compress: true, putOnlyUsedFonts: true });
  const available = registerFonts(doc, fontData);
  const warnings = [];
  const FM = book.front || parseFrontMatter(S.frontMatter?.text || '', S.input);
  const fm = FM.meta;

  // ---------- fonts & measuring ----------
  const warned = new Set();
  const role = (name, over = {}) => {
    const r = { ...S.fonts[name], ...over };
    const fam = resolveFamily(r.family, available);
    if (fam !== r.family && !warned.has(r.family)) {
      warned.add(r.family);
      warnings.push(`Font “${FAMILIES[r.family]?.label || r.family}” could not be loaded – using ${BUILTIN[fam]?.label || fam}.`);
    }
    return { fam, style: r.style || 'normal', size: Number(r.size) || 11, tracking: Number(r.tracking) || 0, color: r.color || null, builtin: !!BUILTIN[fam] };
  };
  const safe = (f, s) => (f.builtin ? winAnsiSafe(s) : s);
  const wCache = new Map();
  const measureWith = (f) => (text, runStyle = 'normal') => {
    const style = compose(f.style, runStyle);
    const key = `${f.fam}|${style}|${f.size}|${f.tracking}|${text}`;
    let w = wCache.get(key);
    if (w == null) {
      doc.setFont(f.fam, style);
      doc.setFontSize(f.size);
      const t = safe(f, text);
      w = doc.getTextWidth(t) + f.tracking * Array.from(t).length;
      wCache.set(key, w);
    }
    return w;
  };

  // ---------- geometry ----------
  const M = S.margins;
  const inside = M.inside * PT, outside = M.outside * PT, top = M.top * PT, bottomM = M.bottom * PT;
  const frame = (pageNo) => {
    const recto = pageNo % 2 === 1;
    const left = M.mirrored ? (recto ? inside : outside) : inside;
    const right = M.mirrored ? (recto ? outside : inside) : outside;
    return { left, right, width: W - left - right, recto };
  };
  const textWidth = W - inside - outside;
  const body = role('body');
  const leading = Number(S.text.leading) || body.size * 1.4;
  const bodyAsc = body.size * 0.78;
  const bodyDesc = body.size * 0.25;
  // Running heads (and top folios) keep their capitals at least 3/8 in from the
  // trim: KDP flags anything inside 1/4 in, and hardcover trimming varies more.
  // If that pushes the head down, the text block moves down with it.
  const SAFE = 0.375 * PT;
  const headFont = role('body', { size: Math.max(7 * K, body.size * 0.78), style: 'italic' });
  const headY = Math.max(14, top - 12, SAFE + headFont.size * 0.72);
  const headsOnTop = S.pages.runningHeads || S.pages.folioPosition === 'top-outside';
  const firstBaseline = top + Math.round(body.size * 1.1) + (headsOnTop ? Math.max(0, headY - (top - 12)) : 0); // 48 at the defaults
  // Bottom folios get at least one full line of leading between them and the text.
  const folioBottom = S.pages.folioPosition !== 'top-outside';
  const lastBaseline = Math.min(H - bottomM, folioBottom ? H - (Number(S.pages.folioOffset) || 24) - leading : Infinity);
  const measureBody = measureWith(body);

  // ---------- display list ----------
  const pages = [];
  const newPage = (kind, extra = {}) => {
    const p = { kind, ops: [], ...extra };
    pages.push(p);
    return p;
  };
  // ---------- ASCII art fillers ----------
  const artPieces = S.art?.enabled ? (book.art || []) : [];
  let artNext = 0;
  /** Centre the next art piece between yTop and yBottom on page `pg`. False if none left or it won't fit. */
  const placeArt = (pg, yTop, yBottom) => {
    if (artNext >= artPieces.length) return false;
    const lines = artPieces[artNext].split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length && !lines[0].trim()) lines.shift();
    const base = role('mono');
    const f = frame(pages.indexOf(pg) + 1);
    const w0 = Math.max(...lines.map((l) => measureWith(base)(l)));
    const size = Math.min(base.size, base.size * f.width / Math.max(w0, 1), (yBottom - yTop) / (lines.length * 1.15 + 0.2));
    if (size < base.size * 0.5) return false;
    const g = { ...base, size };
    const lead = size * 1.15;
    const w = w0 * size / base.size;
    const h = (lines.length - 1) * lead + size * 1.06;
    const x = f.left + (f.width - w) / 2;
    const y0 = yTop + (yBottom - yTop - h) / 2 + size * 0.78;
    lines.forEach((l, i) => textOp(pg, l, x, y0 + i * lead, g));
    artNext++;
    return true;
  };
  const ensureRecto = (fill = false) => {
    if (pages.length % 2 === 0) return;
    const b = newPage('blank');
    if (fill && placeArt(b, top, H - bottomM)) b.kind = 'art';
  };
  const fr = () => frame(pages.length);

  // Characters an embedded font has no glyph for would print blank: collect them.
  const glyphMaps = new Map();
  const missingGlyphs = new Map(); // char → font label
  const checkGlyphs = (fam, style, text) => {
    const k = `${fam}|${style}`;
    let map = glyphMaps.get(k);
    if (map === undefined) {
      try { map = doc.getFont(fam, style)?.metadata?.cmap?.unicode?.codeMap || null; } catch { map = null; }
      glyphMaps.set(k, map);
    }
    if (!map) return;
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c > 32 && c !== 0xa0 && !map[c] && !missingGlyphs.has(ch)) missingGlyphs.set(ch, FAMILIES[fam]?.label || fam);
    }
  };

  const textOp = (page, text, x, y, f, style = f.style, extra = {}) => {
    if (!text) return;
    if (!f.builtin) checkGlyphs(f.fam, style, text);
    page.ops.push({ t: 'text', text: safe(f, text), x, y, fam: f.fam, style, size: f.size, cs: f.tracking || 0, color: f.color, ...extra });
  };

  /** Draw broken lines at baseline y with given leading. Returns baseline after last line. */
  const drawLines = (page, lines, f, x, width, y, lead, align, extra = {}) => {
    const m = measureWith(f);
    const space = m(' ');
    for (const line of lines) {
      const pos = placeLine(line, x, width, align, space);
      line.items.forEach((it, i) => {
        let cx = pos[i];
        for (const seg of it.segs) {
          const st = compose(f.style, seg.style);
          // Draw space-separated pieces individually: jsPDF's Identity-H output
          // doesn't reliably advance by the space glyph inside one string.
          const parts = seg.text.split(' ');
          parts.forEach((part, k) => {
            if (k) cx += m(' ', seg.style);
            textOp(page, part, cx, y, f, st, extra);
            cx += m(part, seg.style);
          });
        }
      });
      y += lead;
    }
    return y - lead;
  };

  const breakText = (text, f, width, opts = {}) => breakLines(parseInline(text), width, {
    measure: measureWith(f), hyphenBreaks: S.text.hyphenBreaks, noDashStart: S.text.noDashLineStart, ...opts,
  });

  /** Centered (or aligned) block of display text; returns last baseline. */
  const displayBlock = (page, text, f, y, lead, align = 'center', width = fr().width, x = fr().left) => {
    const lines = breakText(text, f, width, { hyphenBreaks: false });
    return drawLines(page, lines, f, x, width, y, lead, align);
  };
  /**
   * Content-aware display text. If it nearly fits on one line, shrink it (down
   * to `minScale` of its size) so it does. Otherwise keep the size and balance
   * the lines: the narrowest measure that still needs the same number of lines,
   * so no word is left alone on the last line.
   */
  const fitBlock = (text, f, width, minScale = 0.82) => {
    const brk = (g, w) => breakText(text, g, w, { hyphenBreaks: false });
    const lines = brk(f, width);
    if (lines.length === 1) return { f, lines };
    for (let sz = f.size - 0.25; sz >= f.size * minScale - 1e-6; sz -= 0.25) {
      const g = { ...f, size: sz };
      const l = brk(g, width);
      if (l.length === 1) return { f: g, lines: l };
    }
    let lo = width / lines.length / 2, hi = width, best = lines;
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      const l = brk(f, mid);
      if (l.length <= lines.length && l.every((x) => x.width <= mid + 0.01)) { hi = mid; best = l; } else lo = mid;
    }
    return { f, lines: best };
  };
  /** Display block centred on the page (not the text frame), fitted to `width`. Returns last baseline. */
  const pageCentered = (page, text, f, y, lead, width = 245 * K, minScale = 0.82) => {
    width = Math.min(width, textWidth);
    const { f: g, lines } = fitBlock(text, f, width, minScale);
    return drawLines(page, lines, g, (W - width) / 2, width, y, lead * (g.size / f.size), 'center');
  };
  /** Letter-spaced single line centred on the page (trailing tracking ignored). */
  const trackedCentered = (page, text, f, y) => {
    const w = measureWith(f)(text) - (f.tracking || 0);
    textOp(page, text, (W - w) / 2, y, f);
  };

  // ---------- front matter (from the frontmatter.md format) ----------
  const fmText = (s) => fill(s, fm);
  const field = (pg, k) => fmText(pg.fields[k + '.print'] ?? pg.fields[k] ?? fm[k + '.print'] ?? fm[k] ?? '');
  const frontPage = {
    title(pg) {
      const p = newPage('front', { label: 'Title page' });
      const tf = role('title', { size: 23 * K, color: '#000000' });
      let y = pageCentered(p, field(pg, 'title'), tf, top + 98, 27 * K, 250 * K, 0.9);
      const sub = field(pg, 'subtitle');
      if (sub) y = pageCentered(p, sub, role('subtitle', { color: '#000000' }), y + 45 * K, 13.5 * K, 230 * K);
      const author = field(pg, 'author');
      const af = role('chapter', { size: 10.5 * K, tracking: 2.625 * K, color: '#000000' });
      if (author) trackedCentered(p, author.toUpperCase(), af, Math.max(y + 40 * K, H - 151));
      const pub = field(pg, 'publisher');
      if (pub) pageCentered(p, pub, role('body', { size: 9 * K }), H - bottomM - 20, 12 * K);
    },
    halftitle(pg) {
      const p = newPage('front', { label: 'Half title' });
      pageCentered(p, field(pg, 'title'), role('title', { size: 16 * K }), top + 110, 20 * K, 230 * K);
    },
    praise(pg) {
      let p = newPage('front', { label: 'Praise' });
      const hf = role('title', { size: 13 * K, color: '#141414' });
      const qf = role('body', { size: 9.5 * K, style: 'italic', color: '#191919' });
      const af = role('chapter', { size: 7 * K, style: 'normal', tracking: 1.75 * K, color: '#5a5a5a' });
      const qw = Math.min(245 * K, textWidth);
      const heading = fmText(pg.fields.heading ?? 'Praise for {title}');
      let y = heading ? pageCentered(p, heading, hf, top + 26, 13 * K) + 41 * K : top + 40;
      for (const para of pg.paras) {
        const q = splitPraise(fmText(para));
        const { lines } = fitBlock(`“${q.quote}”`, qf, qw, 1); // balanced lines, no lone last word
        if (y + (lines.length - 1) * 12 * K + (q.by ? 16 * K : 0) > lastBaseline + EPS) {
          p = newPage('front', { label: 'Praise (cont.)' });
          warnings.push('Praise page overflowed onto a second page.');
          y = firstBaseline;
        }
        y = drawLines(p, lines, qf, (W - qw) / 2, qw, y, 12 * K, 'center');
        if (q.by) { y += 16 * K; trackedCentered(p, q.by.toUpperCase(), af, y); }
        y += 21 * K;
      }
    },
    copyright(pg) {
      // Small type, set from the foot of the page upwards. Lines in a group sit
      // tight; a blank line in frontmatter.md starts a new group.
      const p = newPage('front', { label: 'Copyright' });
      const f = fr();
      const cf = role('body', { size: Math.max(7 * K, body.size * 0.78), color: '#1e1e1e' });
      const hf = { ...cf, style: 'bold' };
      const lead = cf.size * 1.35;
      const gap = lead * 0.6;
      const groups = pg.groups.map((g) => [...g]);
      const isbn = pg.fields.isbn ?? fm.isbn;
      if (isbn && !pg.paras.some((x) => /isbn/i.test(x))) groups.push([`ISBN ${isbn}`]);
      const heading = fmText(pg.fields.heading ?? '');
      const rows = [];
      if (heading) rows.push(...breakText(heading, hf, f.width, { hyphenBreaks: false }).map((l) => ({ l, font: hf })), null);
      groups.forEach((g, gi) => {
        if (gi) rows.push(null);
        for (const para of g) rows.push(...breakText(fmText(para), cf, f.width, { hyphenBreaks: false }).map((l) => ({ l, font: cf })));
      });
      const total = rows.reduce((a, r) => a + (r ? lead : gap), -lead);
      // Always stop clear of the folio line, so turning front-matter folios on can't cause a clash.
      const folioY = H - (Number(S.pages.folioOffset) || 24);
      const foot = Math.min(lastBaseline, folioY - (Number(S.pages.folioSize) || 9) - lead);
      let y = Math.max(firstBaseline, foot - total);
      for (const r of rows) {
        if (!r) { y += gap; continue; }
        drawLines(p, [r.l], r.font, f.left, f.width, y, lead, 'left');
        y += lead;
      }
    },
    dedication(pg) {
      const p = newPage('front', { label: 'Dedication' });
      const df = role('body', { style: 'italic' });
      let y = top + H * 0.25;
      for (const para of pg.paras) y = pageCentered(p, fmText(para), df, y, leading) + leading + 6 * K;
    },
    epigraph(pg) {
      const p = newPage('front', { label: 'Epigraph' });
      const ef = role('body', { style: 'italic' });
      const af = role('chapter', { size: 7 * K, style: 'normal', tracking: 1.75 * K, color: '#5a5a5a' });
      let y = top + H * 0.22;
      for (const para of pg.paras) {
        const q = splitPraise(fmText(para));
        y = pageCentered(p, q.quote, ef, y, leading);
        if (q.by) { y += 18 * K; trackedCentered(p, q.by.toUpperCase(), af, y); }
        y += 30 * K;
      }
    },
    page(pg) {
      const p = newPage('front', { label: field(pg, 'heading') || 'Page' });
      const center = (pg.fields.align || '').toLowerCase() === 'center';
      const heading = fmText(pg.fields.heading ?? '');
      let y = firstBaseline;
      if (heading) y = displayBlock(p, heading, role('title', { size: 15 * K }), top + Number(S.opener.sinkage || 42), 19 * K, center ? 'center' : 'left') + 30 * K;
      pg.paras.forEach((para, i) => {
        const f = fr();
        const lines = breakText(fmText(para), body, f.width, { firstIndent: center || i === 0 ? 0 : Number(S.text.indent) || 0 });
        y = drawLines(p, lines, body, f.left, f.width, y, leading, center ? 'center' : (S.text.align === 'justify' ? 'justify' : 'left')) + leading + (Number(S.text.paraGap) || 0);
      });
    },
    blank() { newPage('blank'); },
    toc() { layoutToc(); },
  };

  // ---------- table of contents ----------
  let tocDone = false;
  function layoutToc() {
    if (tocDone || !S.toc.enabled) return;
    tocDone = true;
    ensureRecto();
    let p = newPage('toc', { label: 'Contents' });
    const hf = role('title', { size: Math.max(14 * K, role('title').size * 0.75) });
    let y = displayBlock(p, S.toc.title || 'Contents', hf, top + S.opener.sinkage * 0.6, hf.size * 1.2) + 40 * K;
    const ef = role('body');
    const sf = role('body', { size: body.size * 0.85, style: 'italic' });
    const numCol = measureBody('00') + 10;
    const pageCol = measureBody('000') + 8;
    book.chapters.forEach((ch, ci) => {
      const f = fr();
      const tw = f.width - numCol - pageCol;
      const tl = breakText(ch.title, ef, tw, { hyphenBreaks: false });
      const sl = S.toc.subtitles && ch.subtitle ? breakText(ch.subtitle, sf, tw, { hyphenBreaks: false }) : [];
      const need = (tl.length + sl.length - 1) * leading;
      if (y + need > lastBaseline + EPS) { p = newPage('toc', { label: 'Contents (cont.)' }); y = firstBaseline; }
      const ff = fr();
      textOp(p, String(ch.num), ff.left, y, ef);
      y = drawLines(p, tl, ef, ff.left + numCol, tw, y, leading, 'left');
      const lastW = tl[tl.length - 1].width;
      p.ops.push({ t: 'tocnum', chapter: ci, x: ff.left + ff.width, y, from: ff.left + numCol + lastW + 6, f: ef, leaders: S.toc.leaders });
      if (sl.length) y = drawLines(p, sl, sf, ff.left + numCol, tw, y + leading * 0.9, leading * 0.9, 'left');
      y += leading * 1.35;
    });
  }

  for (const pg of FM.pages) frontPage[pg.type](pg);
  for (const w of FM.warnings) warnings.push(w.message);
  layoutToc();

  // ---------- chapters ----------
  let frontCount = pages.length;
  const chapterStart = [];
  const align = S.text.align === 'justify' ? 'justify' : 'left';
  const cfg = S.callout;
  let page = null;
  let y = 0;

  const newBodyPage = (ci) => { page = newPage('body', { chapter: ci }); y = firstBaseline; };
  /** A verso that ends a chapter with only a paragraph or so gets art in the space below. */
  const fillShortVerso = () => {
    if (!page || pages.length % 2 === 1 || page.opener || (page.paras || 0) >= (Number(S.art?.minParas) || 2)) return;
    placeArt(page, y - bodyAsc + leading * 0.5, lastBaseline + bodyDesc);
  };
  const atTop = () => Math.abs(y - firstBaseline) < EPS;

  const flowParagraph = (text, indent, ci, font = body, alignTo = align) => {
    const f = fr();
    const lines = breakText(text, font, f.width, { firstIndent: indent });
    const min = Math.max(1, Number(S.text.minLines) || 2);
    let i = 0;
    while (i < lines.length) {
      if (y > lastBaseline + EPS) newBodyPage(ci);
      const fit = Math.floor((lastBaseline - y) / leading + EPS) + 1;
      const remain = lines.length - i;
      let take = Math.min(fit, remain);
      if (take < remain && S.text.widowOrphan) {
        if (S.text.widowControl && remain - take < min) take = remain - min; // widow: carry ≥ `min` lines over
        if (i === 0 && take < min) take = 0;             // orphan: never leave < `min` lines at the foot
        if (take <= 0 && atTop()) take = Math.min(fit, remain); // can't satisfy (tiny page) – just flow
      }
      if (take > 0) {
        const ff = fr();
        drawLines(page, lines.slice(i, i + take), font, ff.left, ff.width, y, leading, alignTo);
        y += take * leading;
        i += take;
      }
      if (i < lines.length) newBodyPage(ci);
    }
    y += Number(S.text.paraGap) || 0;
  };

  // ``` log block: monospaced, line breaks kept, between two thin rules
  const flowLog = (text, ci) => {
    const mf = role('mono');
    const L = S.log || {};
    const ml = Number(L.leading) || mf.size * 1.3;
    const inset = Number(L.indent) || 0;
    const space = Number(L.space) || 0;
    const pad = 6 * K;
    const asc = mf.size * 0.78, desc = mf.size * 0.28;
    const mm = measureWith(mf);
    const w = textWidth - inset * 2;
    const rows = text.split('\n').flatMap((src) => {
      if (!src.trim()) return [null];
      const lead = src.match(/^\s*/)[0];
      return breakLines([{ text: src.trim().replace(/▲/g, '\u00A0'), italic: false, bold: false }], w, { measure: mm, hyphenBreaks: false, firstIndent: lead ? mm(lead) : 0 })
        .map((r) => Object.assign(r, { lead: lead ? mm(lead) : 0, tris: [...src.trim()].map((c, col) => (c === '▲' ? col : -1)).filter((c) => c >= 0) }));
    });
    const step = (r) => (r ? ml : ml * 0.6);
    const limit = lastBaseline + bodyDesc;
    const fitRows = (from, top) => {
      let h = pad + asc, n = 0;
      for (let k = from; k < rows.length; k++) {
        const add = n === 0 ? 0 : step(rows[k - 1]);
        if (top + h + add + desc + pad > limit + EPS) break;
        h += add; n++;
      }
      return n;
    };
    let i = 0;
    while (i < rows.length) {
      if (y > lastBaseline + EPS) newBodyPage(ci);
      let top = y - bodyAsc + (atTop() ? 0 : space);
      let n = fitRows(i, top);
      if (n < rows.length - i && !atTop()) { newBodyPage(ci); top = y - bodyAsc; n = fitRows(i, top); }
      n = Math.max(1, n);
      const f = fr();
      const x = f.left + inset;
      let by = top + pad + asc;
      for (let k = i; k < i + n; k++) {
        if (rows[k]) {
          drawLines(page, [rows[k]], mf, x, w, by, ml, 'left');
          // ▲ cells are drawn as vector triangles (Courier Prime has no triangle glyph)
          const cell = mm('0');
          for (const col of rows[k].tris || []) {
            const cx = x + (rows[k].lead || 0) + col * cell;
            page.ops.push({ t: 'tri', x: cx + cell * 0.2, y: by, w: cell * 0.6, h: mf.size * 0.62, color: '#2a2a2a' });
          }
        }
        if (k < i + n - 1) by += step(rows[k]);
      }
      const bottom = by + desc + pad;
      if (L.rules !== false) {
        page.ops.push({ t: 'rect', x, y: top, w, h: 0.5, color: L.ruleColor || '#8a8a8a' });
        page.ops.push({ t: 'rect', x, y: bottom, w, h: 0.5, color: L.ruleColor || '#8a8a8a' });
      }
      y = bottom + space + bodyAsc;
      i += n;
      if (i < rows.length) newBodyPage(ci);
    }
  };

  // *** scene break: a centred mark; never stranded at the foot of a page
  const flowBreak = (ci) => {
    if (y + leading * 2 > lastBaseline + EPS) newBodyPage(ci);
    const mark = S.sceneBreak || '*';
    const f = fr();
    textOp(page, mark, f.left + (f.width - measureBody(mark)) / 2, y, body);
    y += leading + (Number(S.text.paraGap) || 0);
  };

  const flowCallout = (text, ci, indent, next) => {
    const cf = role('callout');
    if (cfg.style !== 'box') {
      // plain: a paragraph set in the callout font, with extra space around it.
      // Kept together, and kept with the first line of whatever follows it.
      if (!atTop()) y += Number(cfg.spaceBefore) || 0;
      if (cfg.keepTogether && !atTop()) {
        const n = breakText(text, cf, fr().width - indent, {}).length;
        let end = y + (n - 1) * leading;
        if (next) end += leading + (Number(S.text.paraGap) || 0) + (Number(cfg.spaceAfter) || 0) + (next.type === 'callout' ? Number(cfg.spaceBefore) || 0 : 0);
        if (end > lastBaseline + EPS) newBodyPage(ci);
      }
      flowParagraph(text, indent, ci, cf);
      y += Number(cfg.spaceAfter) || 0;
      return;
    }
    const cl = Number(cfg.leading) || cf.size * 1.35;
    const pad = Number(cfg.padding) || 0;
    const rule = Number(cfg.rule) || 0;
    const inset = rule + pad + (rule ? 2 : 0);
    const lines = breakText(text, cf, textWidth - inset - pad, {});
    const asc = cf.size * 0.78, desc = cf.size * 0.28;
    const boxFor = (n) => pad + asc + (n - 1) * cl + desc + pad;
    const space = Number(cfg.space) || 0;
    let i = 0;
    while (i < lines.length) {
      if (y > lastBaseline + EPS) newBodyPage(ci);
      let boxTop = y - bodyAsc + (atTop() ? 0 : Math.max(0, space - (Number(S.text.paraGap) || 0)));
      const limit = lastBaseline + bodyDesc;
      let fit = Math.floor((limit - boxTop - pad - asc - desc - pad) / cl + EPS) + 1;
      const remain = lines.length - i;
      if (fit < remain && (cfg.keepTogether || fit < 2) && !atTop()) {
        newBodyPage(ci);
        boxTop = y - bodyAsc;
        fit = Math.floor((limit - boxTop - pad - asc - desc - pad) / cl + EPS) + 1;
      }
      const take = Math.max(1, Math.min(fit, remain));
      const h = boxFor(take);
      const f = fr();
      if (cfg.tint) page.ops.push({ t: 'rect', x: f.left, y: boxTop, w: f.width, h, color: cfg.tintColor });
      if (rule) page.ops.push({ t: 'rect', x: f.left, y: boxTop, w: rule, h, color: cfg.ruleColor });
      drawLines(page, lines.slice(i, i + take), cf, f.left + inset, f.width - inset - pad, boxTop + pad + asc, cl, 'left', { color: cfg.textColor });
      i += take;
      y = boxTop + h + space + bodyAsc;
      if (i < lines.length) newBodyPage(ci);
    }
  };

  book.chapters.forEach((ch, ci) => {
    if (ci > 0) fillShortVerso();
    if (S.pages.chapterRecto) ensureRecto(true);
    if (ci === 0) frontCount = pages.length;
    page = newPage('body', { chapter: ci, opener: true });
    chapterStart[ci] = pages.length;
    const f = fr();
    const oAlign = S.opener.align === 'center' ? 'center' : 'left';
    const O = S.opener;
    let yy = top + Number(O.sinkage || 0);
    const label = O.label;
    if (label && label !== 'none') {
      if (label === 'number') {
        const nf = role('title', { size: role('title').size * 1.6 });
        yy = displayBlock(page, String(ch.num), nf, yy, nf.size, oAlign);
      } else {
        const lf = role('chapter');
        const n = label === 'numeral' ? String(ch.num) : numberToWords(ch.num);
        const txt = `Chapter ${n}`.toUpperCase();
        // tracking is ignored after the last letter when centring
        const lw = measureWith(lf)(txt) - (lf.tracking || 0);
        textOp(page, txt, oAlign === 'center' ? f.left + (f.width - lw) / 2 : f.left, yy, lf);
      }
      yy += Number(O.labelGap) || 24;
    }
    const tf = role('title');
    yy = displayBlock(page, O.uppercase ? ch.title.toUpperCase() : ch.title, tf, yy, Number(O.titleLeading) || tf.size * 1.13, oAlign);
    if (ch.subtitle) {
      const sf = role('subtitle');
      yy = displayBlock(page, ch.subtitle, sf, yy + (Number(O.subtitleGap) || 27.5), sf.size * 1.3, oAlign);
    }
    if (O.ornament) {
      const ow = 36 * K, ox = oAlign === 'center' ? f.left + (f.width - ow) / 2 : f.left;
      page.ops.push({ t: 'rect', x: ox, y: yy + (Number(O.afterGap) || 0) / 2, w: ow, h: 0.6, color: '#555555' });
    }
    y = yy + (Number(O.afterGap) || 0) + bodyAsc;
    if (y > lastBaseline) newBodyPage(ci);

    ch.blocks.forEach((b, bi) => {
      const prevType = ch.blocks[bi - 1]?.type;
      const flush = (bi === 0 && !S.text.indentFirst) || prevType === 'break';
      const indent = flush ? 0 : Number(S.text.indent) || 0;
      const p0 = pages.length - 1;
      if (b.type === 'log') flowLog(b.text, ci);
      else if (b.type === 'break') flowBreak(ci);
      else if (b.type === 'callout') flowCallout(b.text, ci, indent, ch.blocks[bi + 1]);
      else if (b.center) flowParagraph(b.text, 0, ci, body, 'center');
      else flowParagraph(b.text, indent, ci);
      for (let k = p0; k < pages.length; k++) pages[k].paras = (pages[k].paras || 0) + 1;
    });
  });

  // ---------- closing blank ----------
  fillShortVerso();
  if (S.pages.endEven) ensureRecto(true);
  if (artPieces.length && artNext < artPieces.length) warnings.push(`${artPieces.length - artNext} of ${artPieces.length} art pieces had no empty verso to go on.`);

  // ---------- render ----------
  const folioFont = role('body', { size: Number(S.pages.folioSize) || 9, style: 'normal', color: S.pages.folioColor || '#000000' });
  const folioFor = (idx) => {
    const n = idx + 1;
    const p = pages[idx];
    if (idx < frontCount) {
      const label = S.pages.frontRoman ? toRoman(n) : String(n);
      const show = p.kind === 'toc' || (S.pages.frontFolios && p.kind !== 'blank');
      return { label, show };
    }
    const label = String(n - frontCount);
    const show = p.kind !== 'blank' && p.kind !== 'art' && (!p.opener || S.pages.openerFolio);
    return { label, show };
  };

  const setFont = (fam, style, size) => { doc.setFont(fam, style); doc.setFontSize(size); };
  let curColor = null;
  const setColor = (hex) => {
    const c = hex || '#000000';
    if (c !== curColor) { doc.setTextColor(...hexToRgb(c)); curColor = c; }
  };

  pages.forEach((p, idx) => {
    if (idx > 0) doc.addPage([W, H], W > H ? 'landscape' : 'portrait');
    curColor = null;
    const f = frame(idx + 1);
    for (const op of p.ops) {
      if (op.t === 'rect') {
        doc.setFillColor(...hexToRgb(op.color));
        doc.rect(op.x, op.y, op.w, op.h, 'F');
      } else if (op.t === 'tri') {
        // a filled triangle, pointing up, with its base on the baseline
        doc.setFillColor(...hexToRgb(op.color));
        doc.lines([[op.w, 0], [-op.w / 2, -op.h]], op.x, op.y, [1, 1], 'F', true);
      } else if (op.t === 'text') {
        setFont(op.fam, op.style, op.size);
        setColor(op.color);
        doc.text(op.text, op.x, op.y, op.cs ? { charSpace: op.cs } : undefined);
      } else if (op.t === 'tocnum') {
        const label = String(chapterStart[op.chapter] - frontCount);
        setFont(op.f.fam, op.f.style, op.f.size);
        setColor(null);
        const lw = doc.getTextWidth(label);
        doc.text(label, op.x - lw, op.y);
        if (op.leaders) {
          const dot = '.';
          const dw = doc.getTextWidth(dot) + 2.2;
          const start = Math.ceil(op.from / dw) * dw; // align dots across lines
          for (let x = start; x + dw <= op.x - lw - 4; x += dw) doc.text(dot, x, op.y, { charSpace: 0 });
        }
      }
    }
    // running heads
    if (S.pages.runningHeads && p.kind === 'body' && !p.opener) {
      const which = f.recto ? (S.pages.runningHeadRecto || 'chapter') : (S.pages.runningHeadVerso || 'title');
      const source = { title: fmText(fm['title.print'] ?? fm.title), author: fmText(fm['author.print'] ?? fm.author), chapter: book.chapters[p.chapter]?.title || '' };
      let txt = source[which] || '';
      if (txt && S.pages.runningHeadUppercase) txt = txt.toUpperCase();
      if (txt) {
        const hl = breakText(txt, headFont, f.width * 0.7, { hyphenBreaks: false });
        const s = hl[0].items.map((it) => it.segs.map((sg) => sg.text).join('')).join(' ') + (hl.length > 1 ? '…' : '');
        setFont(headFont.fam, headFont.style, headFont.size);
        setColor('#333333');
        const tw = doc.getTextWidth(s);
        doc.text(safe(headFont, s), f.left + (f.width - tw) / 2, headY);
      }
    }
    // folio
    const fo = folioFor(idx);
    if (fo.show) {
      setFont(folioFont.fam, folioFont.style, folioFont.size);
      setColor(folioFont.color);
      const lw = doc.getTextWidth(fo.label);
      const pos = S.pages.folioPosition;
      const fy = pos === 'top-outside' ? headY : H - (Number(S.pages.folioOffset) || 26);
      let fx;
      if (idx < frontCount) fx = (W - lw) / 2;                       // front matter: centred on the page
      else if (pos === 'bottom-outside' || pos === 'top-outside') fx = f.recto ? f.left + f.width - lw : f.left;
      else fx = f.left + (f.width - lw) / 2;
      doc.text(fo.label, fx, fy);
    }
  });

  // ---------- metadata & bookmarks ----------
  doc.setProperties({
    title: fmText(fm.title), subject: fmText(fm['subtitle.print'] ?? fm.subtitle), author: fmText(fm.author),
    creator: 'Manuscript Maker', keywords: '',
  });
  try { doc.setLanguage?.(S.epub.language === 'en' ? 'en-US' : S.epub.language); } catch { /* optional */ }
  try {
    if (doc.outline) {
      book.chapters.forEach((ch, ci) => doc.outline.add(null, `${ch.num}. ${ch.title}`, { pageNumber: chapterStart[ci] }));
    }
  } catch (e) { warnings.push('Could not add PDF bookmarks: ' + e.message); }

  for (const [ch, fam] of missingGlyphs) warnings.push(`“${ch}” (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) isn’t in ${fam}, so it prints blank. Replace it in the text or pick another font.`);
  return {
    doc,
    warnings,
    layout: pages,
    pageCount: pages.length,
    frontCount,
    chapters: book.chapters.map((ch, ci) => ({ num: ch.num, title: ch.title, page: chapterStart[ci] - frontCount, physical: chapterStart[ci] })),
  };
}
