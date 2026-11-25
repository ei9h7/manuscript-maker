import { DEFAULT_FRONT_MATTER } from './frontmatter.js';

// Default book settings. Everything here can be overridden by a `book.json`
// in the writing repo, or from the layout form in the web app.
// Lengths: trim + margins in inches, typography in points (1in = 72pt).

export const TRIM_PRESETS = {
  '5x8': [5, 8],
  '5.25x8': [5.25, 8],
  '5.5x8.5': [5.5, 8.5],
  '6x9': [6, 9],
  'a5': [5.83, 8.27],
};

export const DEFAULTS = {
  // Large print: multiplies every type size, leading, gap and indent together
  // (margins and trim stay put). 1.45 takes 11pt body type to about 16pt.
  scale: 1,
  trim: { preset: '5x8', width: 5, height: 8 },
  margins: { mirrored: true, inside: 0.75, outside: 0.5, top: 0.5, bottom: 0.5 },
  pages: {
    chapterRecto: true,        // chapters open on a right-hand page (blank verso inserted)
    frontRoman: true,          // front matter counts i, ii, iii…
    frontFolios: false,        // print folios on title/praise/copyright pages (never on blanks)
    openerFolio: false,        // print folio on chapter-opening pages
    folioPosition: 'bottom-outside', // body folios: bottom-outside | bottom-center | top-outside
    folioOffset: 26,           // pt from page edge to folio baseline
    folioSize: 9,
    folioColor: '#141414',
    runningHeads: false,
    runningHeadVerso: 'title', // title | author | chapter | none
    runningHeadRecto: 'chapter',
    runningHeadUppercase: false,
    endEven: true,             // add a blank last page so the book ends on a verso (even page count)
  },
  fonts: {
    chapter: { family: 'Barlow', style: 'normal', size: 8, tracking: 2, color: '#464646' },
    title: { family: 'CrimsonPro', style: 'bold', size: 19, color: '#000000' },
    subtitle: { family: 'CrimsonPro', style: 'italic', size: 11, color: '#373737' },
    body: { family: 'CrimsonPro', style: 'normal', size: 11, color: '#000000' },
    callout: { family: 'Barlow', style: 'normal', size: 9.5, color: '#1f1f1f' },
    mono: { family: 'CourierPrime', style: 'normal', size: 8.5, color: '#2a2a2a' },
  },
  text: {
    leading: 15.5,
    paraGap: 6.5,              // extra space between paragraphs (on top of the leading)
    indent: 12,
    indentFirst: false,        // indent the first paragraph after a chapter heading
    align: 'left',             // left (ragged right) | justify
    widowOrphan: true,         // keep at least `minLines` of a paragraph together at the foot of a page
    widowControl: true,        // also never leave fewer than `minLines` at the top of the next page
    minLines: 2,               // lines kept together at page top/bottom
    hyphenBreaks: true,        // also break at hyphens to fill a line (words too long for a line are always split)
    noDashLineStart: true,     // move the word before a spaced em dash down so no line starts with “—”
  },
  callout: {
    style: 'box',              // box: tinted box with a left rule | plain: indented paragraph in the callout font
    spaceBefore: 11,           // plain style: extra space above
    spaceAfter: 3.5,           // plain style: extra space below
    leading: 13,               // box style
    keepTogether: true,        // box style
    rule: 2,
    ruleColor: '#3a3a3a',
    tint: true,
    tintColor: '#f1efe9',
    textColor: '#1f1f1f',
    padding: 8,
    space: 9,
  },
  opener: {
    sinkage: 42,               // pt from top margin to the chapter label baseline
    label: 'numeral',          // numeral (CHAPTER 1) | words (CHAPTER ONE) | number (1) | none
    align: 'left',             // left | center
    labelGap: 24,              // label baseline → title baseline
    titleLeading: 21.5,
    subtitleGap: 27.5,         // last title baseline → subtitle baseline
    afterGap: 40.5,            // subtitle baseline → top of the first text line
    ornament: false,
    uppercase: false,          // set chapter titles in capitals (use fonts.title.tracking to space them)
  },
  // ``` fenced log blocks and *** scene breaks
  log: { leading: 11, indent: 24, rules: true, ruleColor: '#8a8a8a', space: 10 },
  sceneBreak: '*',
  // ASCII art from art.md (``` fenced pieces), used in order: on a verso left blank so a
  // chapter can open recto, and below the text of a verso that ends a chapter with fewer
  // than `minParas` paragraphs (if the piece fits).
  art: { enabled: false, minParas: 2, file: 'art.md' },
  toc: { enabled: false, title: 'Contents', leaders: true, subtitles: false },
  input: { smartQuotes: true, smartDashes: true, ellipses: true, calloutPattern: '', calloutBoldLead: true },
  epub: { embedFonts: true, visibleToc: true, language: 'en' },
  // Front matter: the pages before chapter 1, in the frontmatter.md format
  // (see src/frontmatter.js). A frontmatter.md next to the manuscript, or a
  // front-matter block at the top of the manuscript, replaces this text.
  frontMatter: { text: DEFAULT_FRONT_MATTER },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = structuredClone(v);
  }
  return out;
}

export function resolveSettings(over) {
  const s = deepMerge(DEFAULTS, over || {});
  const p = TRIM_PRESETS[s.trim.preset];
  if (p) [s.trim.width, s.trim.height] = p;
  return s;
}

// Settings that are typographic lengths, multiplied by `scale`.
const SCALED = [
  'pages.folioSize',
  'text.leading', 'text.paraGap', 'text.indent',
  'callout.spaceBefore', 'callout.spaceAfter', 'callout.leading', 'callout.rule', 'callout.padding', 'callout.space',
  'opener.labelGap', 'opener.titleLeading', 'opener.subtitleGap', 'opener.afterGap',
  'log.leading', 'log.indent', 'log.space',
];

/** Apply `scale` to a resolved settings object. Returns a copy with scale 1. */
export function scaleSettings(S) {
  const k = Number(S.scale) || 1;
  if (k === 1) return S;
  const out = structuredClone(S);
  for (const f of Object.values(out.fonts)) {
    if (f.size) f.size = +(Number(f.size) * k).toFixed(2);
    if (f.tracking) f.tracking = +(Number(f.tracking) * k).toFixed(3);
  }
  for (const p of SCALED) {
    const v = Number(getPath(out, p));
    if (Number.isFinite(v) && v) setPath(out, p, +(v * k).toFixed(2));
  }
  out.scale = 1;
  out.scaled = k;
  return out;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys[keys.length - 1]] = value;
}

/** Fill {title} {author} {year} {isbn} placeholders. */
export function interpolate(str, fm) {
  return String(str ?? '').replace(/\{(\w+)\}/g, (m, k) => (fm[k] != null ? String(fm[k]) : m));
}
