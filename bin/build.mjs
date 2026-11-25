#!/usr/bin/env node
// Command-line build: node bin/build.mjs manuscript.md [--config book.json] [--front frontmatter.md] [--pdf out.pdf] [--epub out.epub] [--no-fonts]
// book.json and frontmatter.md next to the manuscript are picked up automatically.
// A directory may be given instead of a file: every .md/.txt in it is concatenated in name order.
import fs from 'node:fs/promises';
import path from 'node:path';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';
import { prepareBook } from '../src/frontmatter.js';
import { lintText } from '../src/text.js';
import { resolveSettings } from '../src/settings.js';
import { loadFonts } from '../src/fonts.js';
import { buildPdf } from '../src/pdf.js';
import { buildEpub } from '../src/epub.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; };
const configPath = opt('--config');
const frontPath = opt('--front');
let pdfOut = opt('--pdf');
let epubOut = opt('--epub');
const noFonts = flag('--no-fonts');
const input = args[0];
if (!input) {
  console.error('usage: build.mjs <manuscript.md|dir> [--config book.json] [--front frontmatter.md] [--pdf out.pdf] [--epub out.epub] [--no-fonts]');
  process.exit(2);
}
if (!pdfOut && !epubOut) { pdfOut = 'dist/book.pdf'; epubOut = 'dist/book.epub'; }

async function readInput(p) {
  const st = await fs.stat(p);
  if (!st.isDirectory()) return fs.readFile(p, 'utf8');
  const names = (await fs.readdir(p)).filter((n) => /\.(md|txt)$/i.test(n) && !/^(readme|frontmatter)/i.test(n)).sort();
  const parts = await Promise.all(names.map((n) => fs.readFile(path.join(p, n), 'utf8')));
  return parts.join('\n');
}

const raw = await readInput(input);
let cfgPath = configPath;
if (!cfgPath) {
  const guess = path.join((await fs.stat(input)).isDirectory() ? input : path.dirname(input), 'book.json');
  try { await fs.access(guess); cfgPath = guess; } catch { /* none */ }
}
const S = resolveSettings(cfgPath ? JSON.parse(await fs.readFile(cfgPath, 'utf8')) : {});
let fmPath = frontPath;
if (!fmPath) {
  const guess = path.join((await fs.stat(input)).isDirectory() ? input : path.dirname(input), 'frontmatter.md');
  try { await fs.access(guess); fmPath = guess; } catch { /* none */ }
}
if (fmPath) S.frontMatter.text = await fs.readFile(fmPath, 'utf8');
const book = prepareBook(raw, S);
console.log(`front matter: ${book.front.source === 'manuscript' ? 'from the manuscript' : fmPath || 'built-in default'} (${book.front.pages.map((p) => p.type).join(', ')})`);
for (const w of book.front.warnings) console.warn(`front: ${w.message}`);
let cover = null;
if (book.front.meta.cover) {
  const base = fmPath ? path.dirname(fmPath) : ((await fs.stat(input)).isDirectory() ? input : path.dirname(input));
  const coverPath = path.resolve(base, book.front.meta.cover);
  try {
    cover = { bytes: await fs.readFile(coverPath), type: /\.png$/i.test(coverPath) ? 'image/png' : 'image/jpeg' };
    console.log(`cover: ${coverPath}`);
  } catch { console.warn(`cover: ${coverPath} not found – EPUB built without a cover`); }
}

for (const w of lintText(raw)) console.warn(`lint: ${w.message} ×${w.count}${w.lines.length ? ' (lines ' + w.lines.join(', ') + ')' : ''}`);
for (const w of book.warnings) console.warn(`warn: ${w.message}`);
console.log(`${book.chapters.length} chapters, ${book.chapters.reduce((a, c) => a + c.blocks.length, 0)} paragraphs`);

const fams = [...new Set(Object.values(S.fonts).map((f) => f.family))];
const { data, errors } = noFonts ? { data: {}, errors: [] } : await loadFonts(fams);
for (const e of errors) console.warn(`font: ${e}`);

if (pdfOut) {
  const t = Date.now();
  const res = buildPdf(book, S, { jsPDF, fontData: data });
  for (const w of res.warnings) console.warn(`pdf: ${w}`);
  await fs.mkdir(path.dirname(pdfOut), { recursive: true });
  await fs.writeFile(pdfOut, Buffer.from(res.doc.output('arraybuffer')));
  console.log(`PDF  → ${pdfOut} (${res.pageCount} pages, ${Date.now() - t} ms)`);
}
if (epubOut) {
  const bytes = await buildEpub(book, S, { JSZip, fontData: S.epub.embedFonts ? data : {}, cover });
  await fs.mkdir(path.dirname(epubOut), { recursive: true });
  await fs.writeFile(epubOut, bytes);
  console.log(`EPUB → ${epubOut}`);
}
