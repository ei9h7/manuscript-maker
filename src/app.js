// Web UI wiring. Everything runs in the browser: the manuscript and token
// never leave this page except to talk to api.github.com.

import { plainText } from './parser.js';
import { prepareBook, extractFrontMatter } from './frontmatter.js';
import { lintText, escapeXml } from './text.js';
import { resolveSettings, getPath, setPath, TRIM_PRESETS } from './settings.js';
import { FAMILIES, BUILTIN, loadFonts } from './fonts.js';
import { buildPdf } from './pdf.js';
import { buildEpub } from './epub.js';
import { importFile, markdownToManuscript } from './importers.js';
import { parseRepoRef, loadFromGitHub } from './github.js';
import { renderSpreads } from './preview.js';
import { toRoman } from './text.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// ------------------------------------------------------------ storage helpers
const store = {
  get(k, session = false) { try { const v = (session ? sessionStorage : localStorage).getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } },
  set(k, v, session = false) { try { (session ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

// ------------------------------------------------------------ state
let settings = resolveSettings(store.get('mm.settings') || {});
let manuscript = store.get('mm.manuscript', true); // { text, name, source }
let lastBuild = null;   // { url, result, book }
let building = false;
let queued = false;

const status = (msg, kind = '') => { const el = $('#status'); el.textContent = msg; el.className = `status ${kind}`; };
const slug = (s) => String(s || 'book').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'book';

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function libs() {
  const jsPDF = window.jspdf?.jsPDF;
  const JSZip = window.JSZip;
  if (!jsPDF || !JSZip) throw new Error('PDF/EPUB libraries failed to load from the CDN. Check your connection and reload.');
  return { jsPDF, JSZip };
}

let mammothPromise = null;
function loadMammoth() {
  mammothPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js';
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => { mammothPromise = null; reject(new Error('Could not load the Word (.docx) converter.')); };
    document.head.appendChild(s);
  });
  return mammothPromise;
}

async function fontsFor(S) {
  const fams = [...new Set(Object.values(S.fonts).map((f) => f.family))].filter((f) => FAMILIES[f]);
  const { data, errors } = await loadFonts(fams);
  return { data, errors };
}

// ------------------------------------------------------------ form
const ROLES = [['chapter', 'Chapter label'], ['title', 'Chapter title'], ['subtitle', 'Subtitle'], ['body', 'Body'], ['callout', 'Callout']];
function buildFontRows() {
  const fams = [...Object.entries(FAMILIES).map(([k, v]) => [k, v.label]), ...Object.entries(BUILTIN).map(([k, v]) => [k, v.label])];
  $('#font-rows').innerHTML = ROLES.map(([r, label]) => `<tr>
    <td>${label}</td>
    <td><select data-k="fonts.${r}.family" aria-label="${label} font">${fams.map(([k, l]) => `<option value="${k}">${escapeXml(l)}</option>`).join('')}</select></td>
    <td><select data-k="fonts.${r}.style" aria-label="${label} style">
      <option value="normal">Regular</option><option value="italic">Italic</option><option value="bold">Semibold</option><option value="bolditalic">Semibold italic</option>
    </select></td>
    <td><input type="number" step="0.5" min="5" max="72" data-k="fonts.${r}.size" aria-label="${label} size (pt)"></td>
  </tr>`).join('');
}

const praiseToText = (arr) => (arr || []).map((q) => (q.by ? `${q.quote} — ${q.by}` : q.quote)).join('\n\n');
const textToPraise = (s) => String(s || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
  const i = Math.max(p.lastIndexOf(' — '), p.lastIndexOf(' -- '));
  return i > 0 ? { quote: p.slice(0, i).trim(), by: p.slice(i + 3).trim() } : { quote: p, by: '' };
});

function fillForm() {
  for (const el of $$('#settings [data-k]')) {
    const v = getPath(settings, el.dataset.k);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (el.dataset.type === 'praise') el.value = praiseToText(v);
    else if (el.dataset.type === 'list') el.value = (v || []).join(', ');
    else el.value = v ?? '';
  }
  syncFormHints();
}

function readField(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') { const n = parseFloat(el.value); return Number.isFinite(n) ? n : getPath(settings, el.dataset.k); }
  if (el.dataset.type === 'praise') return textToPraise(el.value);
  if (el.dataset.type === 'list') return el.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return el.value;
}

function syncFormHints() {
  $('#custom-trim').hidden = settings.trim.preset !== 'custom';
  const m = settings.margins;
  for (const el of $$('[data-mirror]')) el.textContent = el.dataset.mirror.split('|')[m.mirrored ? 0 : 1];
  const w = settings.trim.width - m.inside - m.outside;
  const h = settings.trim.height - m.top - m.bottom;
  $('#text-block').textContent = `Page ${settings.trim.width} × ${settings.trim.height} in (${Math.round(settings.trim.width * 72)} × ${Math.round(settings.trim.height * 72)} pt). Text block ${w.toFixed(2)} × ${h.toFixed(2)} in (${Math.round(w * 72)} pt wide).`;
}

function onFormChange(e) {
  const el = e.target;
  if (!el.dataset?.k) return;
  if (el.type === 'radio' && !el.checked) return;
  setPath(settings, el.dataset.k, readField(el));
  if (el.dataset.k === 'trim.preset' && TRIM_PRESETS[el.value]) {
    [settings.trim.width, settings.trim.height] = TRIM_PRESETS[el.value];
    fillForm();
  }
  store.set('mm.settings', settings);
  syncFormHints();
  if (el.dataset.k.startsWith('input.')) renderCheck();
  scheduleBuild();
}

// ------------------------------------------------------------ manuscript & check
function setManuscript(text, name, source, report) {
  manuscript = { text, name, source };
  store.set('mm.manuscript', manuscript, true);
  $('#source-info').hidden = false;
  $('#source-info').innerHTML = `<b>${escapeXml(name)}</b><br><span class="hint">${escapeXml(source)}</span>`;
  const rep = $('#import-report');
  if (report?.length) {
    rep.hidden = false;
    rep.innerHTML = `<span class="hint">Import notes</span><ul>${report.map((r) => `<li>${escapeXml(r)}</li>`).join('')}</ul>`;
  } else rep.hidden = true;
  $('#btn-md').hidden = false;
  $('#btn-refresh').disabled = false;
  $('#empty').hidden = true;
  renderCheck();
  build();
}

function renderCheck() {
  if (!manuscript) return;
  const book = prepareBook(manuscript.text, settings);
  const lint = lintText(manuscript.text);
  const blocks = book.chapters.flatMap((c) => c.blocks);
  const words = blocks.reduce((a, b) => a + plainText(b.text).split(/\s+/).filter(Boolean).length, 0);
  const callouts = blocks.filter((b) => b.type === 'callout').length;
  $('#check-card').hidden = false;
  $('#stats').textContent = `${book.chapters.length} chapters · ${blocks.length - callouts} paragraphs · ${callouts} callouts · ${words.toLocaleString()} words`;
  const fixOn = { quotes: settings.input.smartQuotes, dashes: settings.input.smartDashes, ellipses: settings.input.ellipses, auto: true };
  const items = [];
  for (const w of [...book.front.warnings, ...book.warnings]) items.push(`<li>${escapeXml(w.message)}</li>`);
  for (const w of lint) {
    const fixed = w.fixable && fixOn[w.fixable];
    const lines = w.lines.filter(Boolean);
    items.push(`<li>${escapeXml(w.message)} <b>×${w.count}</b>${fixed ? ' <span class="fixed">· fixed automatically in the output</span>' : ''}${lines.length ? `<span class="lines">Line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}${w.count > lines.length ? '…' : ''}${w.sample ? ` · e.g. “${escapeXml(w.sample)}”` : ''}</span>` : ''}</li>`);
  }
  for (const w of lastBuild?.result?.warnings || []) items.push(`<li>${escapeXml(w)}</li>`);
  $('#warnings').innerHTML = items.length ? items.join('') : '<li class="ok">✓ No problems found. Quotes, dashes and markup look clean.</li>';
  return book;
}

// ------------------------------------------------------------ build
let timer = null;
function scheduleBuild() {
  if (!manuscript || !$('#live').checked) return;
  clearTimeout(timer);
  timer = setTimeout(build, 600);
}

async function build() {
  if (!manuscript) return;
  if (building) { queued = true; return; }
  building = true;
  try {
    status('Building PDF…');
    const { jsPDF } = libs();
    const t0 = performance.now();
    const book = prepareBook(manuscript.text, settings);
    const S = resolveSettings(settings);
    const { data, errors } = await fontsFor(S);
    const result = buildPdf(book, S, { jsPDF, fontData: data });
    result.warnings.push(...errors.map((e) => `Font download failed: ${e}`));
    const blob = result.doc.output('blob');
    if (lastBuild?.url) URL.revokeObjectURL(lastBuild.url);
    const url = URL.createObjectURL(blob);
    lastBuild = { url, blob, result, book, S };
    await showPreview();
    $('#btn-pdf').disabled = false;
    $('#btn-epub').disabled = false;
    const fc = result.frontCount;
    $('#pageinfo').textContent = `${result.pageCount} pages · ${fc} front-matter page${fc === 1 ? '' : 's'} · chapter 1 on page ${result.chapters[0]?.physical ?? '–'}${result.layout.at(-1)?.kind === 'blank' ? ' · last page blank' : ''}`;
    renderCheck();
    status(`Built ${result.pageCount} pages in ${Math.round(performance.now() - t0)} ms.`, result.warnings.length ? '' : 'ok');
  } catch (e) {
    console.error(e);
    status(e.message || String(e), 'err');
  } finally {
    building = false;
    if (queued) { queued = false; build(); }
  }
}

function folioLabels(result, S) {
  return result.layout.map((p, i) => {
    if (p.kind === 'blank') return `${i + 1} · blank`;
    if (i < result.frontCount) return `${S.pages.frontRoman ? toRoman(i + 1) : i + 1} · ${p.label || 'front'}`;
    return String(i + 1 - result.frontCount);
  });
}

async function showPreview() {
  if (!lastBuild) return;
  const mode = $('input[name=view]:checked').value;
  const frame = $('#frame');
  const sp = $('#spreads');
  const native = () => {
    sp.hidden = true;
    frame.hidden = false;
    frame.src = `${lastBuild.url}#view=FitH`;
  };
  if (mode === 'native') return native();
  frame.hidden = true;
  sp.hidden = false;
  try {
    await renderSpreads(sp, await lastBuild.blob.arrayBuffer(), { labels: folioLabels(lastBuild.result, lastBuild.S), spreads: mode === 'spreads' });
  } catch (e) {
    console.error(e);
    native(); // fall back to the browser's own PDF viewer
  }
}

async function downloadEpub() {
  if (!manuscript) return;
  try {
    status('Building EPUB…');
    const { JSZip } = libs();
    const S = resolveSettings(settings);
    const book = prepareBook(manuscript.text, S);
    const { data } = S.epub.embedFonts ? await fontsFor(S) : { data: {} };
    const blob = await buildEpub(book, S, { JSZip, fontData: data, type: 'blob' });
    download(blob, `${slug(book.front.meta.title)}.epub`);
    status('EPUB downloaded.', 'ok');
  } catch (e) {
    console.error(e);
    status(e.message, 'err');
  }
}

/** Only the settings that differ from the defaults – a tidy book.json. */
function diff(cur, base) {
  if (Array.isArray(cur) || typeof cur !== 'object' || cur === null) return JSON.stringify(cur) === JSON.stringify(base) ? undefined : cur;
  const out = {};
  for (const k of Object.keys(cur)) {
    const d = diff(cur[k], base?.[k]);
    if (d !== undefined) out[k] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

// ------------------------------------------------------------ sources
async function loadGitHub() {
  const ref = parseRepoRef($('#gh-repo').value);
  if (!ref) { status('Enter a repository as owner/repo.', 'err'); return; }
  if ($('#gh-path').value.trim()) ref.path = $('#gh-path').value.trim();
  if ($('#gh-ref').value.trim()) ref.ref = $('#gh-ref').value.trim();
  const token = $('#gh-token').value.trim();
  const remember = $('#gh-remember').checked;
  store.set('mm.repo', { repo: $('#gh-repo').value.trim(), path: $('#gh-path').value.trim(), ref: $('#gh-ref').value.trim(), remember });
  store.del('mm.token');
  if (token) store.set('mm.token', token, !remember);
  try {
    status(`Loading ${ref.owner}/${ref.repo}…`);
    $('#gh-load').disabled = true;
    const res = await loadFromGitHub(ref, token);
    const notes = [];
    if (res.config) {
      settings = resolveSettings(res.config);
      store.set('mm.settings', settings);
      fillForm();
      notes.push(`Layout loaded from ${res.configPath}.`);
    } else notes.push('No book.json found, so the current layout settings are used.');
    if (res.front != null) {
      settings.frontMatter.text = res.front;
      store.set('mm.settings', settings);
      fillForm();
      notes.push(`Front matter loaded from ${res.frontPath}.`);
    } else if (extractFrontMatter(res.text).front != null) notes.push('Front matter taken from the top of the manuscript.');
    else notes.push('No frontmatter.md found, so the front matter in the form is used.');
    if (res.files.length > 1) notes.push(`Joined ${res.files.length} files: ${res.files.join(', ')}`);
    const conv = markdownToManuscript(res.text);
    if (!/Already in manuscript format/.test(conv.report[0])) notes.push(...conv.report);
    setManuscript(conv.text, res.files.length > 1 ? `${ref.path}/` : res.files[0], `github.com/${ref.owner}/${ref.repo}${ref.ref ? ` @ ${ref.ref}` : ''}`, notes);
  } catch (e) {
    console.error(e);
    status(e.message, 'err');
  } finally {
    $('#gh-load').disabled = false;
  }
}

async function loadFile(file) {
  if (!file) return;
  try {
    status(`Importing ${file.name}…`);
    const deps = { DOMParser: window.DOMParser, JSZip: window.JSZip };
    if (/\.docx$/i.test(file.name)) deps.mammoth = await loadMammoth();
    // A front-matter file (starts with a [page] line, no chapters) goes into the front-matter box.
    if (/\.(md|txt)$/i.test(file.name)) {
      const txt = await file.text();
      const ex = extractFrontMatter(txt);
      if (ex.front != null && !/^#{1,2}\s+\S/m.test(ex.body)) {
        settings.frontMatter.text = txt;
        store.set('mm.settings', settings);
        fillForm();
        status(`Front matter loaded from ${file.name}.`, 'ok');
        renderCheck();
        scheduleBuild();
        return;
      }
    }
    const res = await importFile(file, deps);
    const report = /Already in manuscript format/.test(res.report[0]) ? [] : res.report;
    setManuscript(res.text, file.name, `Uploaded file · ${res.chapters} chapter${res.chapters === 1 ? '' : 's'} found`, report);
  } catch (e) {
    console.error(e);
    status(e.message, 'err');
  }
}

async function loadSample() {
  try {
    status('Loading sample…');
    const get = (f) => fetch(f).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    const [md, front] = await Promise.all([get('sample/manuscript.md'), get('sample/frontmatter.md')]);
    if (md == null) throw new Error('sample not found');
    settings = resolveSettings({}); // the sample uses the default layout
    if (front != null) settings.frontMatter.text = front;
    store.set('mm.settings', settings);
    fillForm();
    setManuscript(md, 'manuscript.md', 'Sample book', []);
  } catch (e) {
    status(`Could not load the sample: ${e.message}`, 'err');
  }
}

// ------------------------------------------------------------ init
function init() {
  buildFontRows();
  fillForm();
  const form = $('#settings');
  form.addEventListener('input', onFormChange);
  form.addEventListener('change', onFormChange);
  form.addEventListener('submit', (e) => e.preventDefault());

  for (const b of $$('.tabs [data-tab]')) {
    b.addEventListener('click', () => {
      for (const o of $$('.tabs [data-tab]')) o.setAttribute('aria-selected', String(o === b));
      for (const p of $$('[data-pane]')) p.hidden = p.dataset.pane !== b.dataset.tab;
    });
  }

  const saved = store.get('mm.repo');
  if (saved) {
    $('#gh-repo').value = saved.repo || '';
    $('#gh-path').value = saved.path || '';
    $('#gh-ref').value = saved.ref || '';
    $('#gh-remember').checked = !!saved.remember;
  }
  $('#gh-token').value = store.get('mm.token') || store.get('mm.token', true) || '';
  $('#gh-load').addEventListener('click', loadGitHub);
  for (const id of ['#gh-repo', '#gh-path', '#gh-ref', '#gh-token']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') loadGitHub(); });
  $('#gh-remember').addEventListener('change', (e) => { if (!e.target.checked) store.del('mm.token'); });

  $('#file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); loadFile(e.dataTransfer.files[0]); });
  $('#sample-load').addEventListener('click', loadSample);

  $('#btn-pdf').addEventListener('click', () => lastBuild && download(lastBuild.blob, `${slug(lastBuild.book.front.meta.title)}.pdf`));
  $('#btn-epub').addEventListener('click', downloadEpub);
  $('#btn-md').addEventListener('click', () => manuscript && download(new Blob([manuscript.text], { type: 'text/markdown;charset=utf-8' }), `${slug(manuscript.name.replace(/\.\w+$/, ''))}.md`));
  $('#btn-front').addEventListener('click', () => download(new Blob([settings.frontMatter.text], { type: 'text/markdown;charset=utf-8' }), 'frontmatter.md'));
  $('#btn-json').addEventListener('click', () => download(new Blob([JSON.stringify(diff({ ...settings, frontMatter: undefined }, resolveSettings({})) || {}, null, 2) + '\n'], { type: 'application/json' }), 'book.json'));
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Reset all layout and front-matter settings to the defaults?')) return;
    settings = resolveSettings({});
    store.set('mm.settings', settings);
    fillForm();
    scheduleBuild();
  });
  $('#btn-refresh').addEventListener('click', build);
  $('#live').addEventListener('change', (e) => { if (e.target.checked) scheduleBuild(); });
  for (const r of $$('input[name=view]')) r.addEventListener('change', () => { store.set('mm.view', r.value); showPreview(); });
  const view = store.get('mm.view') || (window.innerWidth < 700 ? 'single' : null);
  const viewRadio = view && $(`input[name=view][value="${view}"]`);
  if (viewRadio) viewRadio.checked = true;

  if (manuscript) setManuscript(manuscript.text, manuscript.name, manuscript.source, []);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
