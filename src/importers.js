// Import .txt / .md / .docx / .epub into the manuscript format.
//
// EPUB import strips the navigation document, NCX and any table-of-contents,
// cover, title or copyright pages, so the result is a clean "print transcript"
// that can be committed to the writing repo and rebuilt as a print PDF.
//
// Browser-only for docx/epub (needs DOMParser; docx also needs mammoth).

import { serializeManuscript } from './parser.js';
import { normalizeText, wordsToNumber } from './text.js';

const OPS_NS = 'http://www.idpf.org/2007/ops';
const SKIP_TAGS = new Set(['script', 'style', 'nav', 'img', 'svg', 'figure', 'audio', 'video', 'iframe', 'object', 'math', 'head', 'template']);
const BLOCK_TAGS = new Set(['p', 'li', 'pre', 'dd', 'dt', 'address']);
const CALLOUT_CLASS = /\b(callout|sidebar|note|box|tip|aside|pullquote|highlight)\b/i;
const SUBTITLE_CLASS = /\b(subtitle|sub-title|chapter-subtitle|subhead)\b/i;
const LABEL_CLASS = /\b(chapter-label|chapter-number|chapnum|label)\b/i;
const SKIP_TYPES = /\b(toc|cover|titlepage|halftitlepage|copyright-page|landmarks|page-list|loi|lot|index|frontispiece)\b/;
const LABEL_RE = /^(?:chapter|ch\.?|part)\s+([\p{L}\p{N}-]+)\.?$/iu;
const NUM_TITLE_RE = /^(?:chapter\s+)?([\p{N}]+|[\p{L}-]+)\s*[.:—–-]\s+(.+)$/iu;

const epubType = (el) => (el.getAttributeNS?.(OPS_NS, 'type') || el.getAttribute?.('epub:type') || '').toLowerCase();
const cls = (el) => el.getAttribute?.('class') || '';
const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** Inline element → manuscript markup (escapes literal * and _). */
function inline(node) {
  let out = '';
  for (const ch of node.childNodes) {
    if (ch.nodeType === 3) {
      out += ch.nodeValue.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_');
      continue;
    }
    if (ch.nodeType !== 1) continue;
    const tag = ch.localName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    if (tag === 'br') { out += ' '; continue; }
    if ((tag === 'a' && /noteref/.test(epubType(ch))) || tag === 'sup' && /^\s*\[?\d+\]?\s*$/.test(ch.textContent)) continue;
    const inner = inline(ch);
    if (!inner.trim()) { out += inner; continue; }
    const style = (ch.getAttribute?.('style') || '').toLowerCase();
    const italic = ['em', 'i', 'cite', 'var', 'dfn'].includes(tag) || /font-style:\s*italic/.test(style);
    const bold = ['strong', 'b'].includes(tag) || /font-weight:\s*(bold|[6-9]00)/.test(style);
    // keep surrounding whitespace outside the markers
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    let core = m[2];
    if (italic) core = `*${core}*`;
    if (bold) core = `**${core}**`;
    out += m[1] + core + m[3];
  }
  return out;
}

class Converter {
  constructor() {
    this.chapters = [];
    this.cur = null;
    this.front = 0;
    this.pendingNum = null;   // "Chapter One" seen, title still to come
    this.report = [];
    this.chapterLevel = 1;
  }

  startChapter(num, title) {
    this.cur = { num, title, subtitle: '', blocks: [] };
    this.chapters.push(this.cur);
  }

  heading(level, el) {
    const text = squash(inline(el));
    if (!text) return;
    const plain = squash(el.textContent);
    if (/^(table of )?contents$/i.test(plain)) return 'toc';
    const label = LABEL_RE.exec(plain) || (/^\p{N}+\.?$/u.test(plain) ? [plain, plain.replace('.', '')] : null);
    if (label) {
      this.pendingNum = wordsToNumber(label[1]) ?? null;
      this.pendingLabel = true;
      return;
    }
    if (this.pendingLabel) {
      this.pendingLabel = false;
      this.startChapter(this.pendingNum, text);
      return;
    }
    // A lower-level heading right after a chapter heading is its subtitle.
    if (this.cur && level > this.chapterLevel && !this.cur.blocks.length && !this.cur.subtitle) {
      this.cur.subtitle = text;
      return;
    }
    if (level > this.chapterLevel && !this.cur) return; // front-matter heading
    if (level > this.chapterLevel && this.cur) {
      // section heading inside a chapter → keep as its own paragraph in bold
      this.cur.blocks.push({ type: 'p', text: `**${text}**` });
      return;
    }
    const nt = NUM_TITLE_RE.exec(plain);
    const n = nt ? wordsToNumber(nt[1]) : null;
    if (nt && n != null) this.startChapter(n, squash(inline(el)).replace(/^.*?[.:—–-]\s+/, ''));
    else this.startChapter(null, text);
  }

  para(text, type = 'p') {
    const t = squash(text);
    if (!t) return;
    if (this.pendingLabel) { this.pendingLabel = false; this.startChapter(this.pendingNum, `Chapter ${this.pendingNum ?? ''}`.trim()); }
    if (!this.cur) { this.front++; return; }
    this.cur.blocks.push({ type, text: t });
  }

  walk(node) {
    for (const el of node.children || []) {
      const tag = el.localName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      const et = epubType(el);
      if (/\b(toc|landmarks|page-list|footnotes?|endnotes?|rearnotes?)\b/.test(et)) continue;
      const hm = /^h([1-6])$/.exec(tag);
      if (hm) { if (this.heading(Number(hm[1]), el) === 'toc') return 'toc'; continue; }
      const c = cls(el);
      if (LABEL_CLASS.test(c) && tag !== 'section' && tag !== 'div') { this.heading(1, el); continue; }
      if (SUBTITLE_CLASS.test(c) && this.cur && !this.cur.blocks.length && !this.cur.subtitle) { this.cur.subtitle = squash(inline(el)); continue; }
      if (tag === 'blockquote' || tag === 'aside' || CALLOUT_CLASS.test(c) || /sidebar|pullquote/.test(et)) {
        const ps = [...el.querySelectorAll('p, li')];
        if (ps.length) ps.forEach((p) => this.para(inline(p), 'callout'));
        else this.para(inline(el), 'callout');
        continue;
      }
      if (tag === 'header' || tag === 'hgroup') {
        // header blocks hold chapter label/title/subtitle
        if (this.walk(el) === 'toc') return 'toc';
        continue;
      }
      if (BLOCK_TAGS.has(tag)) { this.para(inline(el)); continue; }
      const hasBlocks = el.querySelector?.('p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, aside');
      if (hasBlocks) { if (this.walk(el) === 'toc') return 'toc'; } else this.para(inline(el));
    }
    return null;
  }

  /** Feed one HTML document. `name` is used in the report. */
  feed(doc, name = 'document') {
    const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
    const plain = squash(body.textContent || '');
    if (!plain) { this.report.push(`Skipped ${name}: empty.`); return; }
    const types = [...body.querySelectorAll('*')].slice(0, 8).map(epubType).join(' ') + ' ' + epubType(body);
    if (SKIP_TYPES.test(types)) { this.report.push(`Removed ${name}: ${types.match(SKIP_TYPES)[1]} page.`); return; }
    // Link-list heuristic for tables of contents without semantics
    const items = [...body.querySelectorAll('p, li')];
    const linky = items.filter((p) => { const a = p.querySelector('a'); return a && squash(a.textContent) === squash(p.textContent); }).length;
    if (items.length >= 3 && linky / items.length > 0.6) { this.report.push(`Removed ${name}: looks like a table of contents.`); return; }
    if (/^©|copyright ©|all rights reserved/i.test(plain) && plain.length < 1500 && !body.querySelector('h1, h2')) {
      this.report.push(`Removed ${name}: copyright page.`); return;
    }
    const before = this.chapters.length;
    if (this.walk(body) === 'toc') {
      // drop anything collected from this document
      this.chapters.length = before;
      this.cur = this.chapters[before - 1] || null;
      this.report.push(`Removed ${name}: table of contents.`);
    }
  }

  result() {
    const chapters = this.chapters.filter((c) => c.blocks.length || c.title);
    if (this.front) this.report.push(`Dropped ${this.front} paragraph(s) before the first chapter heading (title page, front matter, etc.).`);
    if (!chapters.length) this.report.push('No chapter headings were found – check the source uses Heading 1/Heading 2 styles.');
    return { text: serializeManuscript(chapters), chapters: chapters.length, report: this.report };
  }
}

/** Use the most common top-level heading as the chapter level. */
function detectLevel(docs) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of docs) for (const h of d.querySelectorAll('h1, h2, h3')) counts[Number(h.localName[1])]++;
  if (counts[1] >= 2) return 1;
  if (counts[1] === 1 && counts[2] >= 2) return 2; // single h1 = book title
  if (counts[2]) return 2;
  return counts[1] ? 1 : 3;
}

export function htmlToManuscript(html, { DOMParser = globalThis.DOMParser } = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const conv = new Converter();
  conv.chapterLevel = detectLevel([doc]);
  conv.feed(doc, 'document');
  return conv.result();
}

// ---------------------------------------------------------------- markdown / text

/**
 * Convert plain text or generic Markdown to the manuscript format.
 * Files already in the format (## n|Title) are returned unchanged.
 */
/**
 * `## Title` chapters with one paragraph per line (blank lines between them are
 * fine) are already the manuscript format, even without `n|` numbers. Wrapped
 * paragraphs (consecutive text lines outside ``` fences) mean it needs converting.
 */
function isManuscriptFormat(text) {
  if (!/^##\s+\S/m.test(text) || /^#\s|^#{3,}\s/m.test(text)) return false;
  let fence = false, prev = false;
  for (const l of text.split('\n')) {
    if (/^\s*```/.test(l)) { fence = !fence; prev = false; continue; }
    if (fence) continue;
    const isText = !!l.trim() && !/^\s*#{1,6}\s/.test(l);
    if (isText && prev) return false;
    prev = isText;
  }
  return true;
}

export function markdownToManuscript(raw) {
  const text = normalizeText(raw);
  if (/^#{1,2}\s+[^\n]*\|/m.test(text)) return { text, chapters: (text.match(/^#{1,2}\s/gm) || []).length, report: ['Already in manuscript format.'] };
  if (isManuscriptFormat(text)) return { text, chapters: (text.match(/^##\s/gm) || []).length, report: ['Already in manuscript format.'] };
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim()).length;
  const blanks = lines.length - nonEmpty;
  const blankMode = blanks >= nonEmpty * 0.1;
  const blocks = [];
  if (blankMode) {
    let buf = [];
    const flush = () => { if (buf.length) blocks.push(buf); buf = []; };
    for (const l of lines) {
      if (!l.trim()) { flush(); continue; }
      if (/^\s*#{1,6}\s/.test(l)) { flush(); blocks.push([l]); continue; }
      buf.push(l);
    }
    flush();
  } else {
    for (const l of lines) if (l.trim()) blocks.push([l]);
  }
  const report = [blankMode ? 'Paragraphs separated by blank lines (wrapped lines joined).' : 'One paragraph per line.'];
  const conv = { chapters: [], cur: null, dropped: 0 };
  let level = 6;
  for (const b of blocks) { const m = /^\s*(#{1,6})\s/.exec(b[0]); if (m) level = Math.min(level, m[1].length); }
  const levels = blocks.map((b) => /^\s*(#{1,6})\s/.exec(b[0])?.[1].length).filter(Boolean);
  if (levels.filter((l) => l === level).length === 1 && levels.some((l) => l === level + 1)) {
    report.push('Single top-level heading treated as the book title.');
    level += 1;
  }
  const clean = (s) => s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const b of blocks) {
    const first = b[0];
    const hm = /^\s*(#{1,6})\s+(.*)$/.exec(first);
    if (hm) {
      const lv = hm[1].length;
      const title = clean(hm[2].replace(/\s+#+\s*$/, ''));
      if (lv < level) continue; // book title
      if (lv === level) {
        const nt = NUM_TITLE_RE.exec(title);
        const n = nt ? wordsToNumber(nt[1]) : null;
        conv.cur = { num: n, title: n != null ? nt[2] : title, subtitle: '', blocks: [] };
        conv.chapters.push(conv.cur);
      } else if (conv.cur && !conv.cur.blocks.length && !conv.cur.subtitle) conv.cur.subtitle = title;
      else if (conv.cur) conv.cur.blocks.push({ type: 'p', text: `**${title}**` });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(first) && b.length === 1) continue; // horizontal rule
    const isQuote = b.every((l) => /^\s*>/.test(l));
    let t = clean(b.map((l) => l.replace(/^\s*>\s?/, '').replace(/^\s*[-*+]\s+(?=\S)/, '').replace(/^\s*\d+\.\s+(?=\S)/, '')).join(' '));
    let type = 'p';
    if (isQuote || /^\[!(callout|note|tip|important|warning|caution)\]/i.test(t)) {
      type = 'callout';
      t = t.replace(/^\[!(callout|note|tip|important|warning|caution)\]\s*/i, '');
    }
    if (!t) continue;
    if (!conv.cur) { conv.dropped++; continue; }
    conv.cur.blocks.push({ type, text: t });
  }
  if (conv.dropped) report.push(`Dropped ${conv.dropped} paragraph(s) before the first heading.`);
  if (!conv.chapters.length) {
    report.push('No headings found – imported as a single chapter.');
    const all = blocks.map((b) => ({ type: 'p', text: clean(b.join(' ')) })).filter((b) => b.text);
    conv.chapters.push({ num: 1, title: 'Chapter One', subtitle: '', blocks: all });
  }
  return { text: serializeManuscript(conv.chapters), chapters: conv.chapters.length, report };
}

// ---------------------------------------------------------------- docx

export async function docxToManuscript(arrayBuffer, { mammoth, DOMParser = globalThis.DOMParser }) {
  if (!mammoth) throw new Error('DOCX import needs mammoth.js');
  const res = await mammoth.convertToHtml({ arrayBuffer }, {
    styleMap: [
      "p[style-name='Title'] => p.book-title:fresh",
      "p[style-name='Subtitle'] => p.subtitle:fresh",
      "p[style-name='Quote'] => blockquote > p:fresh",
      "p[style-name='Intense Quote'] => blockquote > p:fresh",
      "p[style-name='Callout'] => blockquote > p:fresh",
    ],
  });
  const doc = new DOMParser().parseFromString(`<body>${res.value}</body>`, 'text/html');
  doc.querySelectorAll('p.book-title').forEach((p) => p.remove());
  const conv = new Converter();
  conv.chapterLevel = detectLevel([doc]);
  conv.feed(doc, 'document');
  const out = conv.result();
  const msgs = (res.messages || []).filter((m) => m.type === 'warning').slice(0, 5).map((m) => `Word: ${m.message}`);
  out.report.push(...msgs);
  return out;
}

// ---------------------------------------------------------------- epub

function resolvePath(base, href) {
  const parts = (base ? base.split('/') : []).concat(decodeURIComponent(href.split('#')[0]).split('/'));
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop(); else out.push(p);
  }
  return out.join('/');
}

export async function epubToManuscript(arrayBuffer, { JSZip, DOMParser = globalThis.DOMParser }) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const xml = async (path) => {
    const f = zip.file(path);
    if (!f) throw new Error(`EPUB is missing ${path}`);
    return new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  };
  const container = await xml('META-INF/container.xml');
  const opfPath = container.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB container.xml has no rootfile');
  const opf = await xml(opfPath);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const manifest = new Map();
  for (const it of opf.getElementsByTagName('item')) {
    manifest.set(it.getAttribute('id'), { href: it.getAttribute('href'), type: it.getAttribute('media-type'), props: it.getAttribute('properties') || '' });
  }
  const spineEl = opf.getElementsByTagName('spine')[0];
  const ncxId = spineEl?.getAttribute('toc');
  const refs = [...opf.getElementsByTagName('itemref')].map((r) => r.getAttribute('idref'));
  const report = [];
  if (ncxId) report.push('Removed toc.ncx (EPUB 2 table of contents).');

  const docs = [];
  for (const id of refs) {
    const it = manifest.get(id);
    if (!it) continue;
    const name = it.href.split('/').pop();
    if (/\bnav\b/.test(it.props)) { report.push(`Removed ${name}: EPUB navigation/table of contents.`); continue; }
    if (!/html/.test(it.type)) continue;
    const f = zip.file(resolvePath(base, it.href));
    if (!f) { report.push(`Missing file ${it.href}.`); continue; }
    const src = await f.async('string');
    let doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(src, 'text/html');
    docs.push({ doc, name });
  }
  const conv = new Converter();
  conv.report = report;
  conv.chapterLevel = detectLevel(docs.map((d) => d.doc));
  for (const { doc, name } of docs) conv.feed(doc, name);
  return conv.result();
}

/** Dispatch on file extension. Returns { text, chapters, report }. */
export async function importFile(file, deps) {
  const name = file.name || '';
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'epub') return epubToManuscript(await file.arrayBuffer(), deps);
  if (ext === 'docx') return docxToManuscript(await file.arrayBuffer(), deps);
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return htmlToManuscript(await file.text(), deps);
  if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'text' || !ext) return markdownToManuscript(await file.text());
  throw new Error(`Unsupported file type .${ext} – use .txt, .md, .docx or .epub`);
}
