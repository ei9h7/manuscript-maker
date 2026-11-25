// Facing-page ("spread") preview rendered with pdf.js, so you can see recto
// and verso pages side by side the way the printed book opens. Pages render
// lazily as they scroll into view.

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
const WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ??= import(PDFJS).then((m) => {
  m.GlobalWorkerOptions.workerSrc = WORKER;
  return m;
}).catch((e) => { pdfjsPromise = null; throw e; }));

let current = null; // { doc, observer }

/**
 * Render `bytes` (ArrayBuffer) into `container` as spreads.
 * labels[i] = folio label for physical page i+1 (optional).
 */
export async function renderSpreads(container, bytes, { labels = [], spreads = true } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const first = await doc.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  const ratio = vp.height / vp.width;

  // keep the reader's place across rebuilds
  const scrollRatio = container.scrollHeight > container.clientHeight ? container.scrollTop / (container.scrollHeight - container.clientHeight) : 0;

  if (current) { current.observer.disconnect(); current.doc.destroy(); }
  const n = doc.numPages;
  const rows = [];
  if (spreads) {
    rows.push([null, 1]);                              // page 1 is a recto: alone on the right
    for (let p = 2; p <= n; p += 2) rows.push([p, p + 1 <= n ? p + 1 : null]);
  } else {
    for (let p = 1; p <= n; p++) rows.push([p]);
  }
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const r = document.createElement('div');
    r.className = 'spread' + (spreads ? '' : ' single');
    for (const p of row) {
      const cell = document.createElement('figure');
      cell.className = 'sheet' + (p ? '' : ' none');
      if (p) {
        cell.dataset.page = p;
        cell.style.aspectRatio = `1 / ${ratio}`;
        const cap = document.createElement('figcaption');
        cap.textContent = labels[p - 1] ? `${labels[p - 1]}` : `p. ${p}`;
        cap.title = `Page ${p} of the PDF file (${p % 2 ? 'right-hand' : 'left-hand'} page)`;
        cell.appendChild(cap);
      }
      r.appendChild(cell);
    }
    frag.appendChild(r);
  }
  container.replaceChildren(frag);
  container.scrollTop = scrollRatio * (container.scrollHeight - container.clientHeight);

  const rendered = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const cell = e.target;
      const p = Number(cell.dataset.page);
      if (rendered.has(p)) continue;
      rendered.add(p);
      doc.getPage(p).then((page) => {
        const cssW = cell.clientWidth;
        const scale = (cssW / vp.width) * Math.min(window.devicePixelRatio || 1, 2.5);
        const v = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(v.width);
        canvas.height = Math.ceil(v.height);
        cell.insertBefore(canvas, cell.firstChild);
        return page.render({ canvasContext: canvas.getContext('2d'), viewport: v }).promise;
      }).catch(() => rendered.delete(p));
    }
  }, { root: container, rootMargin: '600px 0px' });
  for (const cell of container.querySelectorAll('.sheet[data-page]')) observer.observe(cell);
  current = { doc, observer };
  return n;
}
