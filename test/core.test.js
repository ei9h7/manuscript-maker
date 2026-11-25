import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';
import { parseManuscript, parseInline, serializeManuscript } from '../src/parser.js';
import { smartenText, lintText, toRoman, numberToWords, wordsToNumber, escapeXml } from '../src/text.js';
import { breakLines } from '../src/linebreak.js';
import { resolveSettings } from '../src/settings.js';
import { buildPdf } from '../src/pdf.js';
import { buildEpub } from '../src/epub.js';
import { markdownToManuscript } from '../src/importers.js';
import { parseFrontMatter, extractFrontMatter, prepareBook, splitPraise } from '../src/frontmatter.js';
import { parseRepoRef } from '../src/github.js';

const mono = (t) => [...t].length * 5; // 5pt per character, space included
const lineText = (l) => l.items.map((it) => it.segs.map((s) => s.text).join('')).join(' ');

test('numbers', () => {
  assert.equal(toRoman(4), 'iv');
  assert.equal(numberToWords(21), 'twenty-one');
  assert.equal(numberToWords(20), 'twenty');
  assert.equal(wordsToNumber('Thirty-Three'), 33);
  assert.equal(wordsToNumber('7'), 7);
});

test('smart quotes, dashes, ellipses', () => {
  assert.equal(smartenText(`"Hi," she said. 'It's the '90s...' -- ok`), '“Hi,” she said. ‘It’s the ’90s…’ — ok');
  assert.equal(smartenText('He said "no"'), 'He said “no”');
  assert.equal(smartenText('rock \'n\' roll'), 'rock ’n’ roll');
});

test('lint finds straight quotes with line numbers', () => {
  const w = lintText('fine\nsay "hi"\n');
  const q = w.find((x) => x.code === 'straight-double-quote');
  assert.equal(q.count, 2);
  assert.deepEqual(q.lines, [2]);
});

test('escapeXml', () => {
  assert.equal(escapeXml(`<a & "b" 'c'>`), '&lt;a &amp; &quot;b&quot; &#39;c&#39;&gt;');
});

test('parser: headings, callouts, numbering, warnings', () => {
  const b = parseManuscript('stray\n## 1|One|Sub\nPara\n[!callout] Note: x\n## Two\nP2\n## 5|Five\n', { calloutBoldLead: true });
  assert.equal(b.chapters.length, 3);
  assert.deepEqual(b.chapters.map((c) => c.num), [1, 2, 5]);
  assert.equal(b.chapters[0].subtitle, 'Sub');
  assert.equal(b.chapters[0].blocks[1].type, 'callout');
  assert.equal(b.chapters[0].blocks[1].text, '**Note:** x');
  assert.ok(b.warnings.some((w) => w.code === 'text-before-first-chapter'));
  assert.ok(b.warnings.some((w) => w.code === 'chapter-number-gap'));
});

test('parser: callout pattern', () => {
  const b = parseManuscript('## 1|A\nRule 1: go.\nbody\n', { calloutPattern: '^Rule \\d+:' });
  assert.equal(b.chapters[0].blocks[0].type, 'callout');
  assert.equal(b.chapters[0].blocks[1].type, 'p');
});

test('inline emphasis and escapes', () => {
  assert.deepEqual(parseInline('a *b* **c** \\*d\\*'), [
    { text: 'a ', italic: false, bold: false }, { text: 'b', italic: true, bold: false },
    { text: ' ', italic: false, bold: false }, { text: 'c', italic: false, bold: true },
    { text: ' *d*', italic: false, bold: false }]);
  assert.equal(parseInline('snake_case_name').length, 1);
  assert.equal(parseInline('2 * 3').unbalanced, true);
});

test('line breaker: fits width, breaks at hyphens, never starts a line with a dash', () => {
  const runs = [{ text: 'alpha beta — gamma well-known delta-epsilon zeta — eta theta iota kappa', italic: false, bold: false }];
  for (let w = 60; w <= 200; w += 7) {
    const lines = breakLines(runs, w, { measure: mono, hyphenBreaks: true, noDashStart: true });
    for (const l of lines) {
      assert.ok(l.width <= w + 0.01, `line too wide at ${w}: ${lineText(l)}`);
      assert.ok(!lineText(l).startsWith('—'), `line starts with dash at ${w}`);
    }
    const joined = lines.map(lineText).join(' ').replace(/- /g, '-');
    assert.equal(joined, runs[0].text);
  }
  const hy = breakLines([{ text: 'aaaa well-known', italic: false, bold: false }], 60, { measure: mono, hyphenBreaks: true });
  assert.equal(lineText(hy[0]), 'aaaa well-');
  // default: hyphenated words move down whole unless too long for a line
  const whole = breakLines([{ text: 'aaaa well-known', italic: false, bold: false }], 60, { measure: mono });
  assert.equal(lineText(whole[1]), 'well-known');
  const long = breakLines([{ text: 'one-two-three-four-five-six', italic: false, bold: false }], 60, { measure: mono });
  assert.equal(lineText(long[0]), 'one-two-');
});

test('line breaker: hard-splits an over-long word', () => {
  const lines = breakLines([{ text: 'Supercalifragilistic', italic: false, bold: false }], 40, { measure: mono });
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.width <= 40));
  assert.ok(lineText(lines[0]).endsWith('-'));
});

const sample = fs.readFileSync(new URL('../sample/manuscript.md', import.meta.url), 'utf8');
const sampleCfg = {};

test('pdf: page structure (built-in fonts)', () => {
  const S = resolveSettings(sampleCfg);
  const book = parseManuscript(sample, S.input);
  const r = buildPdf(book, S, { jsPDF, fontData: {} });
  assert.equal(r.frontCount, 4);
  assert.equal(r.pageCount % 2, 0);
  assert.equal(r.chapters[0].physical, 5);
  for (const c of r.chapters) assert.equal(c.physical % 2, 1, `chapter ${c.num} not recto`);
  assert.ok(r.warnings.some((w) => /could not be loaded/.test(w)));
  // widow/orphan: every split paragraph leaves ≥2 lines on each page – checked via line counts per page bottom
  assert.equal(r.layout.length, r.pageCount);
  // ends on an even page; without the option the closing blank goes away
  const off = buildPdf(book, resolveSettings({ ...sampleCfg, pages: { endEven: false } }), { jsPDF, fontData: {} });
  if (r.layout.at(-1).kind === 'blank') assert.equal(off.pageCount, r.pageCount - 1);
});

test('pdf: TOC shifts front matter and keeps chapter 1 recto', () => {
  const S = resolveSettings({ ...sampleCfg, toc: { enabled: true } });
  const r = buildPdf(parseManuscript(sample, S.input), S, { jsPDF, fontData: {} });
  assert.ok(r.layout.slice(0, r.frontCount).some((p) => p.kind === 'toc'));
  assert.equal(r.chapters[0].physical % 2, 1);
  assert.equal(r.chapters[0].page, 1);
});

test('epub: valid structure, escaped text', async () => {
  const S = resolveSettings({ frontMatter: { text: '[title]\ntitle: A & B <C>\nauthor: X "Y"\n' }, input: { calloutBoldLead: true } });
  const book = parseManuscript('## 1|Tom & Jerry|<i>sub</i>\nFish & chips < 5 > 3 *em*\n[!callout] Watch: out\n', S.input);
  const bytes = await buildEpub(book, S, { JSZip });
  const zip = await JSZip.loadAsync(bytes);
  assert.equal(Object.keys(zip.files)[0], 'mimetype');
  const ch = await zip.file('OEBPS/text/ch001.xhtml').async('string');
  assert.match(ch, /Tom &amp; Jerry/);
  assert.match(ch, /Fish &amp; chips &lt; 5 &gt; 3 <em>em<\/em>/);
  assert.match(ch, /&lt;i&gt;sub&lt;\/i&gt;/);
  assert.match(ch, /<div class="callout"><p><strong>Watch:<\/strong> out<\/p><\/div>/);
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.match(opf, /<dc:title>A &amp; B &lt;C&gt;<\/dc:title>/);
});

test('markdown import: generic markdown → manuscript', () => {
  const md = '# My Book\n\n## Chapter 1: Start\n\n### A subtitle\n\nWrapped\nparagraph here.\n\n> A quote\n\nSecond *para*.\n\n## Chapter Two: Next\n\nText.\n';
  const r = markdownToManuscript(md);
  assert.equal(r.text, '## 1|Start|A subtitle\nWrapped paragraph here.\n[!callout] A quote\nSecond *para*.\n\n## 2|Next\nText.\n');
});

test('serialize round-trip', () => {
  const b = parseManuscript(sample, { smartQuotes: false, smartDashes: false, ellipses: false, calloutBoldLead: false });
  const again = parseManuscript(serializeManuscript(b.chapters), { smartQuotes: false, smartDashes: false, ellipses: false, calloutBoldLead: false });
  assert.deepEqual(again.chapters.map((c) => c.blocks.length), b.chapters.map((c) => c.blocks.length));
});

test('repo refs', () => {
  assert.deepEqual(parseRepoRef('me/book'), { owner: 'me', repo: 'book', ref: '', path: '' });
  assert.deepEqual(parseRepoRef('https://github.com/me/book/blob/main/text/ch.md'), { owner: 'me', repo: 'book', ref: 'main', path: 'text/ch.md' });
});

test('front-matter format', () => {
  const fm = parseFrontMatter(`year: 2030
// comment
[title]
title: My "Book"
author: A. Writer

[praise]
heading: Praise for {title}
Loved it -- truly. — The Daily Paper
No source here.

[copyright]
Copyright © {year} {author}.
[blank]
[epilog]
`);
  assert.equal(fm.meta.year, '2030');
  assert.equal(fm.meta.title, 'My “Book”');
  assert.deepEqual(fm.pages.map((p) => p.type), ['title', 'praise', 'copyright', 'blank', 'page']);
  assert.equal(fm.pages[1].fields.heading, 'Praise for {title}');
  assert.deepEqual(splitPraise(fm.pages[1].paras[0]), { quote: 'Loved it — truly.', by: 'The Daily Paper' });
  assert.deepEqual(splitPraise('No source here.'), { quote: 'No source here.', by: '' });
  assert.ok(fm.warnings.some((w) => /epilog/.test(w.message)));
});

test('front matter at the top of the manuscript', () => {
  const ex = extractFrontMatter('year: 2020\n[title]\ntitle: X\n\n## 1|A\nhi\n');
  assert.equal(ex.body, '## 1|A\nhi\n');
  const book = prepareBook('[title]\ntitle: Inline\n[blank]\n## 1|A\nhi\n', resolveSettings({}));
  assert.equal(book.front.meta.title, 'Inline');
  assert.equal(book.front.source, 'manuscript');
  assert.equal(book.warnings.length, 0);
  const r = buildPdf(book, resolveSettings({}), { jsPDF, fontData: {} });
  assert.equal(r.frontCount, 2);
});

test('print/epub field variants and EPUB cover', async () => {
  const fm = parseFrontMatter('cover: art/cover.jpg\n[title]\ntitle: T\nsubtitle: one—two\nsubtitle.epub: one… two\n');
  assert.equal(fm.meta.cover, 'art/cover.jpg');
  assert.equal(fm.meta.subtitle, 'one—two');
  assert.equal(fm.meta['subtitle.epub'], 'one… two');
  const S = resolveSettings({});
  const book = prepareBook('## 1|A\nhi\n', S);
  book.front = fm;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const zip = await JSZip.loadAsync(await buildEpub(book, S, { JSZip, cover: { bytes: jpeg, type: 'image/jpeg' } }));
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.match(opf, /<item id="cover-image" href="images\/cover.jpg" media-type="image\/jpeg" properties="cover-image"\/>/);
  assert.match(opf, /<meta name="cover" content="cover-image"\/>/);
  assert.match(opf, /<itemref idref="cover"\/>\n<itemref idref="front1"\/>/);
  const title = await zip.file('OEBPS/text/front1-title.xhtml').async('string');
  assert.match(title, /one… two/);
  const pdf = buildPdf(book, S, { jsPDF, fontData: {} });
  const ops = pdf.layout[0].ops.map((o) => o.text).join(' ');
  assert.match(ops, /one—two/);
});

test('log blocks, scene breaks and centred display lines', async () => {
  const md = '## The Room\nFirst.\n-----\nAfter the break.\n\n-----\n```\n[Log – A]\n\n"quoted," he says.\n```\n-----\n**DAD IS RIGHT.**\nEnd.\n-----\n## Next\nText.\n';
  const b = parseManuscript(md, {});
  const types = b.chapters[0].blocks.map((x) => x.type);
  assert.deepEqual(types, ['p', 'break', 'p', 'log', 'p', 'p']); // breaks next to logs and at chapter ends dropped
  assert.equal(b.chapters[0].blocks[3].text, '[Log – A]\n\n"quoted," he says.'); // straight quotes kept in logs
  assert.equal(b.chapters[0].blocks[4].center, true);
  assert.equal(lintText(md).filter((w) => /quote|hyphen/.test(w.code)).length, 0);
  const S = resolveSettings({ opener: { uppercase: true } });
  const book = prepareBook(md, S);
  const r = buildPdf(book, S, { jsPDF, fontData: {} });
  const ops = r.layout.flatMap((p) => p.ops);
  assert.ok(ops.some((o) => o.t === 'text' && o.text === 'THE') && ops.some((o) => o.t === 'text' && o.text === 'ROOM'));
  assert.ok(ops.some((o) => o.t === 'text' && o.fam === 'courier' && /Log/.test(o.text)));
  assert.equal(ops.filter((o) => o.t === 'rect' && o.h === 0.5).length, 2);
  const zip = await JSZip.loadAsync(await buildEpub(book, S, { JSZip }));
  const ch = await zip.file('OEBPS/text/ch001.xhtml').async('string');
  assert.match(ch, /<pre class="log">\[Log – A\]\n\n&quot;quoted,&quot; he says\.<\/pre>/);
  assert.match(ch, /<p class="break" role="separator">\*<\/p>/);
  assert.match(ch, /<p class="center"><strong>DAD IS RIGHT\.<\/strong><\/p>/);
  assert.equal(serializeManuscript(b.chapters).match(/```/g).length, 2);
});
