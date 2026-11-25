// Font loading: Crimson Pro + Barlow TTFs from jsDelivr (Google Fonts, OFL),
// registered with jsPDF. If a download fails the family falls back to a
// built-in PDF font (Times for serif, Helvetica for sans).

const CDN = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts';

export const FAMILIES = {
  CrimsonPro: {
    label: 'Crimson Pro',
    css: "'Crimson Pro', 'Times New Roman', serif",
    fallback: 'times',
    faces: {
      normal: `${CDN}/crimson-pro@0.4.2/400Regular/CrimsonPro_400Regular.ttf`,
      italic: `${CDN}/crimson-pro@0.4.2/400Regular_Italic/CrimsonPro_400Regular_Italic.ttf`,
      bold: `${CDN}/crimson-pro@0.4.2/600SemiBold/CrimsonPro_600SemiBold.ttf`,
      bolditalic: `${CDN}/crimson-pro@0.4.2/600SemiBold_Italic/CrimsonPro_600SemiBold_Italic.ttf`,
    },
  },
  Barlow: {
    label: 'Barlow',
    css: "'Barlow', 'Helvetica Neue', Arial, sans-serif",
    fallback: 'times',
    faces: {
      normal: `${CDN}/barlow@0.4.1/400Regular/Barlow_400Regular.ttf`,
      italic: `${CDN}/barlow@0.4.1/400Regular_Italic/Barlow_400Regular_Italic.ttf`,
      bold: `${CDN}/barlow@0.4.1/600SemiBold/Barlow_600SemiBold.ttf`,
      bolditalic: `${CDN}/barlow@0.4.1/600SemiBold_Italic/Barlow_600SemiBold_Italic.ttf`,
    },
  },
};

export const BUILTIN = {
  times: { label: 'Times (built-in)', css: "'Times New Roman', serif" },
  helvetica: { label: 'Helvetica (built-in)', css: 'Helvetica, Arial, sans-serif' },
  courier: { label: 'Courier (built-in)', css: "'Courier New', monospace" },
};

export function arrayBufferToBase64(buf) {
  if (typeof Buffer !== 'undefined') return Buffer.from(buf).toString('base64');
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const cache = new Map(); // url → Promise<ArrayBuffer>

/**
 * Download font files. Returns { data: {Family: {style: ArrayBuffer}}, errors: [] }.
 * Only the families named in `families` are fetched.
 */
export async function loadFonts(families = Object.keys(FAMILIES), { fetchFn = globalThis.fetch, onProgress } = {}) {
  const data = {};
  const errors = [];
  const jobs = [];
  for (const fam of families) {
    const def = FAMILIES[fam];
    if (!def) continue;
    data[fam] = {};
    for (const [style, url] of Object.entries(def.faces)) {
      if (!cache.has(url)) {
        cache.set(url, fetchFn(url).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        }));
      }
      jobs.push(cache.get(url)
        .then((buf) => { data[fam][style] = buf; onProgress?.(fam, style); })
        .catch((e) => { cache.delete(url); errors.push(`${def.label} ${style}: ${e.message}`); }));
    }
  }
  await Promise.all(jobs);
  return { data, errors };
}

/**
 * Register loaded fonts with a jsPDF document.
 * A family is usable only if its regular face loaded; missing styles
 * fall back to the regular face.
 * @returns Set of usable custom family names
 */
export function registerFonts(doc, data) {
  const ok = new Set();
  for (const [fam, faces] of Object.entries(data || {})) {
    if (!faces.normal) continue;
    for (const style of ['normal', 'italic', 'bold', 'bolditalic']) {
      const buf = faces[style] || (style === 'bolditalic' ? faces.bold : null) || faces.normal;
      const file = `${fam}-${style}.ttf`;
      doc.addFileToVFS(file, arrayBufferToBase64(buf));
      doc.addFont(file, fam, style);
    }
    ok.add(fam);
  }
  return ok;
}

/** Map a requested family to what is actually available in this document. */
export function resolveFamily(fam, available) {
  if (BUILTIN[fam]) return fam;
  if (available.has(fam)) return fam;
  return FAMILIES[fam]?.fallback || 'times';
}

// Characters WinAnsi (built-in PDF fonts) can show. Anything else gets replaced.
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const BUILTIN_SUBS = { '‐': '-', '‑': '-', '‒': '–', '―': '—', ' ': ' ', ' ': ' ',
  ' ': ' ', '′': "'", '″': '"', '−': '-', '⁄': '/', ' ': ' ' };

/** Make text safe for built-in (WinAnsi) fonts. Returns the cleaned string. */
export function winAnsiSafe(s) {
  let out = '';
  for (const c of s) {
    const code = c.codePointAt(0);
    if (code < 0x7f || (code >= 0xa0 && code <= 0xff) || WINANSI_EXTRA.includes(c)) out += c;
    else out += BUILTIN_SUBS[c] ?? '?';
  }
  return out;
}
