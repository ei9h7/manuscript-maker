// Read a manuscript (and optional book.json) from a GitHub repository –
// private repos work with a fine-grained personal access token that has
// read-only "Contents" permission on that one repo.

const API = 'https://api.github.com';

/** Accepts "owner/repo", "owner/repo/path/file.md" or a github.com URL. */
export function parseRepoRef(input) {
  let s = String(input || '').trim().replace(/\.git$/, '');
  const url = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/(?:blob|tree)\/([^/]+)\/?(.*))?/.exec(s);
  if (url) return { owner: url[1], repo: url[2], ref: url[3] || '', path: decodeURIComponent(url[4] || '') };
  s = s.replace(/^github\.com\//, '');
  const [owner, repo, ...rest] = s.split('/');
  if (!owner || !repo) return null;
  return { owner, repo, ref: '', path: rest.join('/') };
}

function headers(token, raw = false) {
  const h = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

const contentsUrl = ({ owner, repo, ref }, path) =>
  `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;

async function request(url, token, raw, fetchFn) {
  const res = await fetchFn(url, { headers: headers(token, raw), cache: 'no-store' });
  if (res.status === 404) {
    const e = new Error(token ? 'Not found – check the repo, branch and path (and that the token can read this repo).' : 'Not found – if the repo is private you need a token.');
    e.status = 404;
    throw e;
  }
  if (res.status === 401) throw new Error('GitHub rejected the token (401). It may be expired or mistyped.');
  if (res.status === 403) throw new Error(`GitHub refused access (403)${res.headers.get('x-ratelimit-remaining') === '0' ? ' – rate limit reached, add a token or wait' : ''}.`);
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  if (raw === 'binary') return res.arrayBuffer();
  return raw ? res.text() : res.json();
}

/**
 * Load the manuscript. If `path` is a directory every .md/.txt file in it is
 * concatenated in name order (so chapters can live in separate files).
 * Also looks for book.json and frontmatter.md next to the manuscript (or at the repo root).
 * @returns { text, files: [paths], config, configPath, front: string|null, frontPath }
 */
export async function loadFromGitHub(ref, token, { fetchFn = globalThis.fetch.bind(globalThis), configPath } = {}) {
  const path = ref.path || 'manuscript.md';
  const meta = await request(contentsUrl(ref, path), token, false, fetchFn);
  let files = [];
  let text = '';
  let dir = '';
  if (Array.isArray(meta)) {
    dir = path;
    files = meta.filter((f) => f.type === 'file' && /\.(md|txt|markdown)$/i.test(f.name) && !/^(readme|frontmatter)/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f) => f.path);
    if (!files.length) throw new Error(`No .md or .txt files in ${path}/`);
    const parts = await Promise.all(files.map((p) => request(contentsUrl(ref, p), token, true, fetchFn)));
    text = parts.join('\n');
  } else {
    dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    files = [meta.path];
    text = await request(contentsUrl(ref, path), token, true, fetchFn);
  }
  let config = null;
  let foundAt = null;
  const candidates = configPath ? [configPath] : [...new Set([dir ? `${dir}/book.json` : 'book.json', 'book.json'])];
  for (const c of candidates) {
    try {
      const raw = await request(contentsUrl(ref, c), token, true, fetchFn);
      config = JSON.parse(raw);
      foundAt = c;
      break;
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(`${c} is not valid JSON: ${e.message}`);
      if (e.status !== 404) throw e;
    }
  }
  let front = null;
  let frontPath = null;
  for (const c of [...new Set([dir ? `${dir}/frontmatter.md` : 'frontmatter.md', 'frontmatter.md'])]) {
    try {
      front = await request(contentsUrl(ref, c), token, true, fetchFn);
      frontPath = c;
      break;
    } catch (e) { if (e.status !== 404) throw e; }
  }
  let art = null;
  try { art = await request(contentsUrl(ref, dir ? `${dir}/art.md` : 'art.md'), token, true, fetchFn); }
  catch (e) { if (e.status !== 404) throw e; }
  return { text, files, config, configPath: foundAt, front, frontPath, dir, art };
}

/**
 * Fetch a binary file (e.g. the cover image) from the repo. `path` is resolved
 * against `baseDir` unless it starts with "/".
 */
export async function fetchRepoFile(ref, token, path, baseDir = '', { fetchFn = globalThis.fetch.bind(globalThis) } = {}) {
  const parts = (path.startsWith('/') ? path.slice(1) : (baseDir ? `${baseDir}/${path}` : path)).split('/');
  const out = [];
  for (const p of parts) { if (!p || p === '.') continue; if (p === '..') out.pop(); else out.push(p); }
  const full = out.join('/');
  return { bytes: await request(contentsUrl(ref, full), token, 'binary', fetchFn), path: full };
}
