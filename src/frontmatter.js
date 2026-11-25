// Front-matter format (frontmatter.md)
// ------------------------------------
// The pages before chapter 1, in order. Each page starts with its type in
// square brackets. "key: value" lines right after the bracket set that
// page's fields; every other line is one paragraph (like the manuscript).
// Lines before the first [page] set book-wide values (year, isbn, …).
//
//   year: 2026
//
//   [title]
//   title: Notes from the Margin
//   subtitle: A short sample book
//   author: A. N. Author
//
//   [praise]
//   heading: Praise for {title}
//   A small book about making books. — The Sample Review
//
//   [copyright]
//   Copyright © {year} {author}. All rights reserved.
//   No part of this book may be reproduced …
//
//   [blank]
//
// Page types: title, halftitle, praise, copyright, dedication, epigraph,
// page (any heading + text), blank, toc (contents, if enabled).
// {title} {subtitle} {author} {year} {publisher} {isbn} are filled in anywhere.
// On the copyright page, a blank line starts a new group: lines in a group
// sit tight together, groups get a little space between them.

import { normalizeText, smartenText } from './text.js';
import { parseManuscript } from './parser.js';

export const PAGE_TYPES = ['title', 'halftitle', 'praise', 'copyright', 'dedication', 'epigraph', 'page', 'blank', 'toc'];
export const FIELDS = ['title', 'subtitle', 'author', 'publisher', 'year', 'isbn', 'heading', 'align', 'language', 'identifier'];

export const DEFAULT_FRONT_MATTER = `year: ${new Date().getFullYear()}

[halftitle]

[praise]
heading: Praise for {title}
Replace this with a real blurb, then the reviewer after a spaced dash. — Reviewer Name

[title]
title: Book Title
subtitle: A subtitle for the book
author: Author Name

[copyright]
Copyright © {year} {author}
All rights reserved.

No part of this book may be reproduced without written permission, except for brief quotations in a review.
`;

/**
 * @returns {{ meta: object, pages: [{type, fields, paras, line}], warnings: [] }}
 */
export function parseFrontMatter(raw, opts = {}) {
  const smart = (s) => smartenText(s, { quotes: opts.smartQuotes !== false, dashes: opts.smartDashes !== false, ellipses: opts.ellipses !== false });
  const meta = {};
  const pages = [];
  const warnings = [];
  let cur = null;
  normalizeText(raw).split('\n').forEach((rawLine, i) => {
    const t = rawLine.trim();
    if (!t) { if (cur && cur.groups[cur.groups.length - 1].length) cur.groups.push([]); return; }
    if (t.startsWith('//')) return;
    const pm = /^\[([a-z-]+)\]$/i.exec(t);
    if (pm) {
      const type = pm[1].toLowerCase();
      if (!PAGE_TYPES.includes(type)) warnings.push({ line: i + 1, message: `Unknown front-matter page [${type}] (line ${i + 1}) – treated as [page].` });
      cur = { type: PAGE_TYPES.includes(type) ? type : 'page', fields: {}, paras: [], groups: [[]], line: i + 1 };
      pages.push(cur);
      return;
    }
    const kv = /^([a-z]+):\s*(.*)$/i.exec(t);
    if (kv && FIELDS.includes(kv[1].toLowerCase()) && (!cur || !cur.paras.length)) {
      (cur ? cur.fields : meta)[kv[1].toLowerCase()] = smart(kv[2]);
      return;
    }
    if (!cur) { warnings.push({ line: i + 1, message: `Front-matter text before the first [page] (line ${i + 1}) is ignored.` }); return; }
    const para = smart(t.replace(/^\\(?=[[a-z])/i, ''));
    cur.paras.push(para);
    cur.groups[cur.groups.length - 1].push(para);
  });
  for (const p of pages) p.groups = p.groups.filter((g) => g.length);
  // Title-page fields are book-wide too.
  for (const p of pages) {
    if (p.type !== 'title') continue;
    for (const k of ['title', 'subtitle', 'author', 'publisher']) if (p.fields[k] && meta[k] == null) meta[k] = p.fields[k];
  }
  if (!meta.year) meta.year = String(new Date().getFullYear());
  return { meta, pages, warnings };
}

/** Fill {placeholders} from the book-wide values. */
export function fill(str, meta) {
  return String(str ?? '').replace(/\{(\w+)\}/g, (m, k) => (meta[k] != null ? String(meta[k]) : m));
}

/** Split a praise paragraph into quote and attribution (after the last " — "). */
export function splitPraise(para) {
  const i = Math.max(para.lastIndexOf(' — '), para.lastIndexOf(' -- '));
  let quote = i > 0 ? para.slice(0, i).trim() : para.trim();
  const by = i > 0 ? para.slice(i + 3).trim() : '';
  quote = quote.replace(/^[“"]|[”"]$/g, '');
  return { quote, by };
}

/**
 * Front matter can live at the top of the manuscript itself (before the
 * first "## " chapter, starting with a [page] line). Returns it split off.
 */
export function extractFrontMatter(raw) {
  const text = String(raw ?? '');
  const m = /^\s*\[(?:title|halftitle|praise|copyright|dedication|epigraph|page|blank|toc)\]\s*$/im.exec(text);
  const ch = /^#{1,2}\s+\S/m.exec(text);
  if (!m || (ch && ch.index < m.index)) return { front: null, body: text };
  // book-wide "key: value" lines may sit above the first [page]
  const before = text.slice(0, m.index);
  const start = before.split('\n').every((l) => !l.trim() || /^[a-z]+:\s/i.test(l.trim())) ? 0 : m.index;
  const end = ch ? ch.index : text.length;
  return { front: text.slice(start, end), body: text.slice(0, start) + text.slice(end) };
}

/**
 * Parse a manuscript plus its front matter. Precedence: a front-matter block
 * at the top of the manuscript, then settings.frontMatter.text (which the CLI
 * and web app fill from frontmatter.md when there is one).
 */
export function prepareBook(raw, S) {
  const { front, body } = extractFrontMatter(raw);
  const book = parseManuscript(body, S.input);
  book.front = parseFrontMatter(front ?? S.frontMatter?.text ?? DEFAULT_FRONT_MATTER, S.input);
  book.front.source = front != null ? 'manuscript' : 'settings';
  return book;
}
