// EPUB 3 builder (with an EPUB 2 toc.ncx for older readers).
// Every piece of user text goes through escapeXml – titles, paragraphs,
// metadata and attributes alike.

import { parseInline } from './parser.js';
import { escapeXml, numberToWords } from './text.js';
import { FAMILIES, BUILTIN } from './fonts.js';
import { parseFrontMatter, fill, splitPraise } from './frontmatter.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const EPUB_NS = 'http://www.idpf.org/2007/ops';

function runsToHtml(text) {
  return parseInline(text).map((r) => {
    let h = escapeXml(r.text);
    if (r.italic) h = `<em>${h}</em>`;
    if (r.bold) h = `<strong>${h}</strong>`;
    return h;
  }).join('');
}

const plain = (text) => parseInline(text).map((r) => r.text).join('');

/** Stable pseudo-UUID from a string (so rebuilding doesn't change the book's identity). */
function stableUuid(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (const c of s) {
    const k = c.codePointAt(0);
    h1 = Math.imul(h1 ^ k, 16777619); h2 = Math.imul(h2 ^ k, 2246822507);
    h3 = Math.imul(h3 ^ k, 3266489909); h4 = Math.imul(h4 ^ k, 668265263);
  }
  const hex = [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const page = (title, lang, bodyClass, inner) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="${EPUB_NS}" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head>
<meta charset="UTF-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="../styles.css"/>
</head>
<body class="${bodyClass}">
${inner}
</body>
</html>
`;

function cssFont(role, embedded) {
  const fam = FAMILIES[role.family];
  const stack = fam ? (embedded.has(role.family) ? `'${role.family}', ${fam.css}` : fam.css) : (BUILTIN[role.family]?.css || 'serif');
  const st = role.style || 'normal';
  return `font-family: ${stack}; font-weight: ${st.includes('bold') ? 600 : 400}; font-style: ${st.includes('italic') ? 'italic' : 'normal'};`;
}

function buildCss(S, embedded) {
  const F = S.fonts, T = S.text, C = S.callout;
  const bs = Number(F.body.size) || 11;
  const em = (pt) => `${+(pt / bs).toFixed(3)}em`;
  const faces = [];
  for (const fam of embedded) {
    for (const [style, weight, italic] of [['normal', 400, false], ['italic', 400, true], ['bold', 600, false], ['bolditalic', 600, true]]) {
      faces.push(`@font-face { font-family: '${fam}'; font-weight: ${weight}; font-style: ${italic ? 'italic' : 'normal'}; src: url(fonts/${fam}-${style}.ttf); }`);
    }
  }
  return `${faces.join('\n')}
body { ${cssFont(F.body, embedded)} line-height: ${+(T.leading / bs).toFixed(3)}; margin: 0 4%; widows: 2; orphans: 2; }
p { margin: ${em(T.paraGap)} 0 0 0; text-indent: ${em(T.indent)}; text-align: ${T.align === 'left' ? 'left' : 'justify'}; -webkit-hyphens: auto; hyphens: auto; }
p.first { text-indent: ${T.indentFirst ? em(T.indent) : '0'}; margin-top: 0; }
section.chapter > header { margin: 3em 0 2.5em 0; text-align: ${S.opener.align === 'left' ? 'left' : 'center'}; page-break-inside: avoid; break-inside: avoid; }
.chapter-label { ${cssFont(F.chapter, embedded)} font-size: ${em(F.chapter.size)}; letter-spacing: 0.2em; text-transform: uppercase; text-indent: 0; margin: 0 0 1em 0; text-align: inherit; }
h1.chapter-title { ${cssFont(F.title, embedded)} font-size: ${em(F.title.size)}; line-height: 1.18; margin: 0; }
.chapter-subtitle { ${cssFont(F.subtitle, embedded)} font-size: ${em(F.subtitle.size)}; line-height: 1.3; text-indent: 0; margin: 0.6em 0 0 0; text-align: inherit; }
${C.style === 'box'
    ? `div.callout { ${cssFont(F.callout, embedded)} font-size: ${em(F.callout.size)}; line-height: ${+(C.leading / F.callout.size).toFixed(3)}; color: ${C.textColor}; ${C.tint ? `background-color: ${C.tintColor};` : ''} border-left: ${C.rule}px solid ${C.ruleColor}; padding: 0.7em 0.9em; margin: 1em 0; page-break-inside: avoid; break-inside: avoid; }
div.callout p { margin: 0; text-indent: 0; text-align: left; }`
    : `div.callout { ${cssFont(F.callout, embedded)} font-size: ${em(F.callout.size)}; margin: ${em(T.paraGap + C.spaceBefore)} 0 ${em(C.spaceAfter)} 0; page-break-inside: avoid; break-inside: avoid; }
div.callout p { margin: 0; text-indent: ${em(T.indent)}; text-align: ${T.align === 'justify' ? 'justify' : 'left'}; }`}
.titlepage { text-align: center; padding-top: 18%; }
.titlepage h1 { ${cssFont(F.title, embedded)} font-size: 2.2em; line-height: 1.15; margin: 0; }
.titlepage .subtitle { ${cssFont(F.subtitle, embedded)} font-size: 1.15em; margin: 1em 0 0 0; text-indent: 0; text-align: center; }
.titlepage .author { ${cssFont(F.chapter, embedded)} letter-spacing: 0.18em; text-transform: uppercase; margin: 4em 0 0 0; text-indent: 0; text-align: center; }
.titlepage .publisher { margin-top: 5em; text-indent: 0; text-align: center; font-size: 0.85em; }
.praise h2 { ${cssFont(F.title, embedded)} text-align: center; font-size: 1.2em; margin: 1em 0 1.5em 0; }
.praise blockquote { margin: 0 0 1.6em 0; text-align: center; }
.praise blockquote p { text-indent: 0; margin: 0; text-align: center; font-style: italic; }
.praise blockquote p.by { ${cssFont({ ...F.chapter, style: 'normal' }, embedded)} font-style: normal; text-transform: uppercase; letter-spacing: 0.18em; font-size: 0.7em; color: #5a5a5a; margin-top: 0.6em; }
.copyright { font-size: 0.8em; padding-top: 30%; }
.copyright p { text-indent: 0; text-align: left; margin: 0; }
.copyright p.gap { margin-top: 1em; }
.copyright p.head { font-weight: 600; }
.frontpage h2 { ${cssFont(F.title, embedded)} font-size: 1.3em; margin: 2em 0 1.5em 0; }
.frontpage.centered { text-align: center; }
.frontpage.centered p { text-indent: 0; text-align: center; }
.dedication { text-align: center; font-style: italic; padding-top: 25%; }
nav#toc ol { list-style: none; padding: 0; margin: 0; }
nav#toc li { margin: 0.5em 0; }
nav#toc a { text-decoration: none; color: inherit; }
nav#toc .sub { display: block; font-style: italic; font-size: 0.85em; }
nav#toc h1, nav#landmarks h1 { ${cssFont(F.title, embedded)} text-align: center; font-size: 1.4em; }
nav#landmarks { display: none; }
`;
}

/**
 * @param book   parsed manuscript
 * @param S      resolved settings
 * @param deps   { JSZip, fontData?: {Family: {style: ArrayBuffer}}, type?: 'uint8array'|'blob' }
 */
export async function buildEpub(book, S, { JSZip, fontData = {}, type = 'uint8array' }) {
  const FM = book.front || parseFrontMatter(S.frontMatter?.text || '', S.input);
  const fm = FM.meta;
  const t = (s) => fill(s, fm);
  const lang = fm.language || S.epub.language || 'en';
  const title = t(fm.title);
  const author = t(fm.author);
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`);

  const manifest = [];
  const spine = [];
  const add = (id, href, mediaType, content, { inSpine = false, props = '', linear = true } = {}) => {
    zip.file(`OEBPS/${href}`, content);
    manifest.push(`<item id="${id}" href="${escapeXml(href)}" media-type="${mediaType}"${props ? ` properties="${props}"` : ''}/>`);
    if (inSpine) spine.push(`<itemref idref="${id}"${linear ? '' : ' linear="no"'}/>`);
  };

  // Fonts actually used by the styles
  const used = new Set(Object.values(S.fonts).map((f) => f.family));
  const embedded = new Set();
  if (S.epub.embedFonts) {
    for (const fam of used) {
      const faces = fontData[fam];
      if (!faces?.normal) continue;
      embedded.add(fam);
      for (const style of ['normal', 'italic', 'bold', 'bolditalic']) {
        const buf = faces[style] || faces.normal;
        add(`font-${fam}-${style}`, `fonts/${fam}-${style}.ttf`, 'font/ttf', buf);
      }
    }
  }
  add('css', 'styles.css', 'text/css', buildCss(S, embedded));

  // Front matter (blank pages and the contents page are print-only)
  const landmarks = [];
  const field = (pg, k) => t(pg.fields[k] ?? fm[k] ?? '');
  FM.pages.forEach((pg, n) => {
    const id = `front${n + 1}`;
    const href = `text/${id}-${pg.type}.xhtml`;
    const addPage = (cls, label, inner) => add(id, href, 'application/xhtml+xml', page(label, lang, cls, inner), { inSpine: true });
    if (pg.type === 'title' || pg.type === 'halftitle') {
      const sub = pg.type === 'title' ? field(pg, 'subtitle') : '';
      const au = pg.type === 'title' ? field(pg, 'author') : '';
      const pub = pg.type === 'title' ? field(pg, 'publisher') : '';
      addPage('titlepage', field(pg, 'title'), `<section epub:type="${pg.type === 'title' ? 'titlepage' : 'halftitlepage'}" class="titlepage">
<h1>${escapeXml(field(pg, 'title'))}</h1>
${sub ? `<p class="subtitle">${escapeXml(sub)}</p>` : ''}
${au ? `<p class="author">${escapeXml(au)}</p>` : ''}
${pub ? `<p class="publisher">${escapeXml(pub)}</p>` : ''}
</section>`);
      if (pg.type === 'title') landmarks.push(['titlepage', href, 'Title Page']);
    } else if (pg.type === 'praise' || pg.type === 'epigraph') {
      const heading = pg.type === 'praise' ? t(pg.fields.heading ?? 'Praise for {title}') : '';
      addPage(pg.type, heading || 'Epigraph', `<section epub:type="${pg.type === 'praise' ? 'preface' : 'epigraph'}" class="praise">
${heading ? `<h2>${escapeXml(heading)}</h2>` : ''}
${pg.paras.map((para) => { const q = splitPraise(t(para)); return `<blockquote><p>${runsToHtml(pg.type === 'praise' ? `“${q.quote}”` : q.quote)}</p>${q.by ? `<p class="by">${escapeXml(q.by)}</p>` : ''}</blockquote>`; }).join('\n')}
</section>`);
    } else if (pg.type === 'copyright') {
      const heading = t(pg.fields.heading ?? '');
      const groups = pg.groups.map((g) => [...g]);
      const isbn = pg.fields.isbn ?? fm.isbn;
      if (isbn && !pg.paras.some((x) => /isbn/i.test(x))) groups.push([`ISBN ${isbn}`]);
      addPage('copyright', 'Copyright', `<section epub:type="copyright-page" class="copyright">
${heading ? `<p class="head">${escapeXml(heading)}</p>` : ''}
${groups.map((g) => g.map((para, i) => `<p${i === 0 ? ' class="gap"' : ''}>${runsToHtml(t(para))}</p>`).join('\n')).join('\n')}
</section>`);
      landmarks.push(['copyright-page', href, 'Copyright']);
    } else if (pg.type === 'dedication') {
      addPage('dedication', 'Dedication', `<section epub:type="dedication" class="dedication">${pg.paras.map((para) => `<p>${runsToHtml(t(para))}</p>`).join('')}</section>`);
    } else if (pg.type === 'page') {
      const heading = t(pg.fields.heading ?? '');
      const center = (pg.fields.align || '').toLowerCase() === 'center';
      addPage(center ? 'frontpage centered' : 'frontpage', heading || title, `<section class="frontpage">
${heading ? `<h2>${escapeXml(heading)}</h2>` : ''}
${pg.paras.map((para, i) => `<p${i === 0 ? ' class="first"' : ''}>${runsToHtml(t(para))}</p>`).join('\n')}
</section>`);
    }
  });

  // Navigation document (always present; visible in reading order only if requested)
  const navItems = book.chapters.map((ch, i) => {
    const href = `text/ch${String(i + 1).padStart(3, '0')}.xhtml`;
    return `<li><a href="${href}">${escapeXml(`${ch.num}. ${plain(ch.title)}`)}${S.toc.subtitles && ch.subtitle ? `<span class="sub">${escapeXml(plain(ch.subtitle))}</span>` : ''}</a></li>`;
  });
  const firstChapter = 'text/ch001.xhtml';
  landmarks.push(['bodymatter', firstChapter, 'Start']);
  const nav = page(S.toc.title || 'Contents', lang, 'nav', `<nav epub:type="toc" id="toc" role="doc-toc">
<h1>${escapeXml(S.toc.title || 'Contents')}</h1>
<ol>
${navItems.map((li) => li.replace(/href="text\//g, 'href="')).join('\n')}
</ol>
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="">
<h1>Landmarks</h1>
<ol>
${landmarks.map(([ty, href, label]) => `<li><a epub:type="${ty}" href="${href.replace(/^text\//, '')}">${escapeXml(label)}</a></li>`).join('\n')}
<li><a epub:type="toc" href="nav.xhtml">${escapeXml(S.toc.title || 'Contents')}</a></li>
</ol>
</nav>`);
  add('nav', 'text/nav.xhtml', 'application/xhtml+xml', nav, { inSpine: S.epub.visibleToc, props: 'nav' });

  // Chapters
  book.chapters.forEach((ch, i) => {
    const id = `ch${String(i + 1).padStart(3, '0')}`;
    const lbl = S.opener.label === 'none' ? '' : S.opener.label === 'number' ? String(ch.num)
      : `Chapter ${S.opener.label === 'numeral' ? ch.num : numberToWords(ch.num)}`;
    let first = true;
    const body = ch.blocks.map((b) => {
      if (b.type === 'callout') return `<div class="callout"><p>${runsToHtml(b.text)}</p></div>`;
      const cls = first ? ' class="first"' : '';
      first = false;
      return `<p${cls}>${runsToHtml(b.text)}</p>`;
    }).join('\n');
    add(id, `text/${id}.xhtml`, 'application/xhtml+xml', page(plain(ch.title), lang, 'chapter', `<section class="chapter" epub:type="chapter" role="doc-chapter" aria-labelledby="${id}-title">
<header>
${lbl ? `<p class="chapter-label">${escapeXml(lbl)}</p>` : ''}
<h1 class="chapter-title" id="${id}-title">${runsToHtml(ch.title)}</h1>
${ch.subtitle ? `<p class="chapter-subtitle">${runsToHtml(ch.subtitle)}</p>` : ''}
</header>
${body}
</section>`), { inSpine: true });
  });

  // NCX (EPUB 2 compatibility)
  const uid = fm.isbn ? `urn:isbn:${fm.isbn.replace(/[^0-9Xx]/g, '')}` : (fm.identifier || `urn:uuid:${stableUuid(title + '\u0000' + author)}`);
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escapeXml(lang)}">
<head><meta name="dtb:uid" content="${escapeXml(uid)}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
${book.chapters.map((ch, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(`${ch.num}. ${plain(ch.title)}`)}</text></navLabel><content src="text/ch${String(i + 1).padStart(3, '0')}.xhtml"/></navPoint>`).join('\n')}
</navMap>
</ncx>
`;
  add('ncx', 'toc.ncx', 'application/x-dtbncx+xml', ncx);

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${escapeXml(uid)}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator id="author">${escapeXml(author)}</dc:creator>
<dc:language>${escapeXml(lang)}</dc:language>
${fm.publisher ? `<dc:publisher>${escapeXml(t(fm.publisher))}</dc:publisher>` : ''}
${FM.pages.find((p) => p.type === 'copyright')?.paras[0] ? `<dc:rights>${escapeXml(t(FM.pages.find((p) => p.type === 'copyright').paras[0]))}</dc:rights>` : ''}
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${spine.join('\n')}
</spine>
</package>
`;
  zip.file('OEBPS/content.opf', opf);

  return zip.generateAsync({ type, mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}
