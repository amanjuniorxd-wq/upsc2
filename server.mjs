// GYANAGI — UPSC server. Zero dependencies (Node >= 18). Serves the study app and three small APIs:
//   GET /api/ca      current affairs: Khoj search across 8 UPSC areas, falling back to PIB RSS, then last-good cache
//   GET /api/pyq     official UPSC question-paper PDFs (index built from upsc.gov.in, cached 24 h)
//   GET /api/health
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const env = (k, d = '') => process.env[k] ?? d;
export const CONFIG = {
  port: Number(env('PORT', '3000')),
  publicDir: resolve(ROOT, env('PUBLIC_DIR', 'public')),
  cacheDir: resolve(ROOT, env('CACHE_DIR', '.cache')),
  khojUrl: env('KHOJ_URL').replace(/\/$/, ''),
  khojKey: env('KHOJ_API_KEY'),
  pibRss: env('PIB_RSS_URL', 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3'),
  upscPyqUrl: env('UPSC_PYQ_URL', 'https://upsc.gov.in/examinations/previous-question-papers'),
  upscPyqPages: Number(env('UPSC_PYQ_PAGES', '25')),
  fetchTimeoutMs: Number(env('FETCH_TIMEOUT_MS', '12000')),
};

// ------------------------------------------------------------------ helpers
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const COMPRESSIBLE = /^(text\/|application\/(json|manifest)|image\/svg)/;
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' };

function send(req, res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { ...HEADERS, 'Content-Type': type, ...extra };
  if (buf.length > 1024 && COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = gzipSync(buf, { level: 6 });
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const json = (req, res, status, obj, extra) => send(req, res, status, obj, undefined, extra);

async function fetchText(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CONFIG.fetchTimeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': 'GyanagiUPSC/1.0', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
const decode = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s, n) => { const w = String(s).split(/\s+/).filter(Boolean); return w.slice(0, n).join(' ') + (w.length > n ? '…' : ''); };

const memo = new Map();                                   // key -> {at, value}
export const resetMemoryCache = () => memo.clear();       // used by tests and by an operator after config changes
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}
async function readCacheFile(name) {
  try { return JSON.parse(await readFile(join(CONFIG.cacheDir, name), 'utf8')); } catch { return null; }
}
async function writeCacheFile(name, obj) {
  try { await mkdir(CONFIG.cacheDir, { recursive: true }); await writeFile(join(CONFIG.cacheDir, name), JSON.stringify(obj)); } catch { /* read-only FS: memory cache still works */ }
}

// ------------------------------------------------------------------ current affairs (8 UPSC areas)
export const AREAS = [
  { id: 'polity', q: 'Indian polity governance parliament supreme court constitution', kw: ['parliament', 'court', 'constitution', 'bill', 'election', 'governor', 'panchayat', 'governance', 'rights', 'cabinet'] },
  { id: 'economy', q: 'Indian economy RBI inflation budget GDP trade', kw: ['rbi', 'inflation', 'gdp', 'budget', 'tax', 'gst', 'bank', 'export', 'import', 'fiscal', 'economy', 'investment', 'msme'] },
  { id: 'environment', q: 'environment climate biodiversity pollution wildlife India', kw: ['climate', 'forest', 'wildlife', 'pollution', 'biodiversity', 'tiger', 'wetland', 'emission', 'environment', 'renewable'] },
  { id: 'science', q: 'science technology ISRO space AI biotechnology India', kw: ['isro', 'space', 'satellite', 'ai', 'artificial intelligence', 'technology', 'quantum', 'semiconductor', 'vaccine', 'research'] },
  { id: 'ir', q: 'India foreign policy bilateral summit G20 BRICS Quad', kw: ['bilateral', 'summit', 'external affairs', 'brics', 'quad', 'g20', 'united nations', 'treaty', 'visit', 'foreign'] },
  { id: 'society', q: 'social welfare scheme health education women India', kw: ['scheme', 'health', 'education', 'women', 'child', 'tribal', 'welfare', 'poverty', 'nutrition', 'skill'] },
  { id: 'culture', q: 'Indian heritage culture art archaeology UNESCO', kw: ['heritage', 'culture', 'unesco', 'temple', 'festival', 'art', 'museum', 'archaeolog', 'dance', 'language'] },
  { id: 'security', q: 'internal security defence disaster management India', kw: ['defence', 'army', 'navy', 'air force', 'missile', 'security', 'disaster', 'cyclone', 'flood', 'terror', 'border', 'drdo'] },
];
const AREA_RE = new Map(AREAS.map((a) => [a.id, a.kw.map((k) => new RegExp(`\\b${k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'))]));
export function areaOf(text) {
  const t = String(text);
  let best = null; let bestN = 0;
  for (const a of AREAS) {
    const n = AREA_RE.get(a.id).reduce((acc, re) => acc + (re.test(t) ? 1 : 0), 0);
    if (n > bestN) { best = a.id; bestN = n; }
  }
  return best;
}

async function khojSearch(area, q) {
  const url = `${CONFIG.khojUrl}/api/search?q=${encodeURIComponent(q || area.q)}&n=6&t=all`;
  const headers = CONFIG.khojKey ? { Authorization: `Bearer ${CONFIG.khojKey}` } : {};
  const arr = JSON.parse(await fetchText(url, { headers }));
  return (Array.isArray(arr) ? arr : []).map((r) => {
    const add = r.additional || {};
    const text = decode(r.entry || add.compiled || '');
    const link = [add.file, add.source, add.url].find((u) => /^https?:\/\//.test(u || '')) || '';
    return { title: decode(add.heading || text.split(/[.\n]/)[0]).slice(0, 160), summary: words(text, 30), url: link,
      source: link ? new URL(link).hostname.replace(/^www\./, '') : 'Khoj', published: add.date || '', area: area.id };
  }).filter((x) => x.title);
}

export function parseRss(xml, source = 'PIB') {
  const items = [];
  for (const m of String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const tag = (n) => decode((block.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i')) || [])[1]);
    const title = tag('title');
    if (!title) continue;
    const desc = tag('description');
    let published = tag('pubDate');
    const d = Date.parse(published);
    published = Number.isNaN(d) ? published : new Date(d).toISOString().slice(0, 10);
    items.push({ title, summary: words(desc || title, 30), url: tag('link'), source, published, area: areaOf(`${title} ${desc}`) });
  }
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((x) => {
    const k = (x.url || x.title).toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function currentAffairs({ area = '', q = '' } = {}) {
  const areas = area ? AREAS.filter((a) => a.id === area) : AREAS;
  const errors = [];
  if (CONFIG.khojUrl) {
    try {
      const lists = await Promise.allSettled(areas.map((a) => cached(`khoj:${a.id}:${q}`, 15 * 60e3, () => khojSearch(a, q))));
      const items = dedupe(lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
      lists.forEach((r) => r.status === 'rejected' && errors.push(`khoj: ${r.reason?.message || r.reason}`));
      if (items.length) {
        await writeCacheFile('ca-last.json', { at: new Date().toISOString(), source: 'khoj', items });
        return { source: 'khoj', items, areas: AREAS.map((a) => a.id) };
      }
    } catch (e) { errors.push(`khoj: ${e.message}`); }
  }
  try {
    const all = await cached('pib', 30 * 60e3, async () => parseRss(await fetchText(CONFIG.pibRss), 'PIB'));
    const ql = q.toLowerCase();
    const items = dedupe(all.filter((x) => (!area || x.area === area) && (!ql || `${x.title} ${x.summary}`.toLowerCase().includes(ql))));
    if (all.length) await writeCacheFile('ca-last.json', { at: new Date().toISOString(), source: 'pib', items: all });
    if (items.length || all.length) return { source: 'pib', items, areas: AREAS.map((a) => a.id), errors };
  } catch (e) { errors.push(`pib: ${e.message}`); }
  const last = await readCacheFile('ca-last.json');
  if (last?.items?.length) {
    const items = last.items.filter((x) => !area || x.area === area);
    return { source: 'cache', cachedAt: last.at, items, areas: AREAS.map((a) => a.id), errors };
  }
  return { source: 'none', items: [], areas: AREAS.map((a) => a.id), errors };
}

// ------------------------------------------------------------------ official PYQ index (upsc.gov.in)
export function classifyPaper(title) {
  const t = title.toLowerCase();
  const year = (t.match(/(?:19|20)\d{2}/g) || []).pop() || '';
  let paper = 'Other';
  if (/prelim/.test(t)) paper = /paper[\s-]*ii\b|paper[\s-]*2\b|csat/.test(t) ? 'Prelims CSAT (GS-II)' : 'Prelims GS-I';
  else if (/essay/.test(t)) paper = 'Essay';
  else if (/general studies|\bgs\b/.test(t)) {
    const n = (t.match(/(?:paper|gs)[\s-]*(iv|iii|ii|i|[1-4])\b/) || [])[1] || '';
    const map = { i: 'I', ii: 'II', iii: 'III', iv: 'IV', 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };
    paper = map[n] ? `Mains GS-${map[n]}` : 'Mains GS';
  } else if (/optional|literature|paper[\s-]*(i|ii)\b/.test(t)) paper = 'Optional';
  else if (/indian language|english|compulsory/.test(t)) paper = 'Qualifying language';
  return { year, paper };
}

export function extractPdfLinks(html, base) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*href=["']([^"']+\.pdf[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = new URL(m[1], base).toString();
    const title = decode(m[2]) || decodeURIComponent(url.split('/').pop());
    out.push({ title, url });
  }
  return out;
}

async function buildPyqIndex() {
  const pages = [];
  for (let p = 0; p < CONFIG.upscPyqPages; p++) pages.push(p);
  const seen = new Set();
  const items = [];
  // fetch pages in small parallel batches; stop when a page yields nothing new
  for (let i = 0; i < pages.length; i += 5) {
    const batch = await Promise.allSettled(pages.slice(i, i + 5).map((p) => {
      const u = new URL(CONFIG.upscPyqUrl);
      if (p) u.searchParams.set('page', String(p));
      return fetchText(u.toString()).then((h) => extractPdfLinks(h, u.toString()));
    }));
    let added = 0;
    for (const r of batch) {
      if (r.status !== 'fulfilled') continue;
      for (const l of r.value) {
        if (seen.has(l.url) || !/civil services|\bcse\b|\bias\b/i.test(`${l.title} ${l.url}`)) continue;
        seen.add(l.url);
        items.push({ ...l, ...classifyPaper(`${l.title} ${l.url}`) });
        added++;
      }
    }
    if (!added && i > 0) break;
  }
  items.sort((a, b) => (b.year || '').localeCompare(a.year || '') || a.paper.localeCompare(b.paper));
  return items;
}

let pyqBuilding = null;
export async function pyqIndex() {
  return cached('pyq', 24 * 3600e3, async () => {
    const file = await readCacheFile('pyq-index.json');
    if (file && Date.now() - Date.parse(file.at) < 24 * 3600e3 && file.items?.length) return file;
    pyqBuilding ||= buildPyqIndex().finally(() => { pyqBuilding = null; });
    try {
      const items = await pyqBuilding;
      if (items.length) {
        const fresh = { at: new Date().toISOString(), items };
        await writeCacheFile('pyq-index.json', fresh);
        return fresh;
      }
    } catch { /* fall through to stale cache */ }
    if (file?.items?.length) return { ...file, stale: true };
    memo.delete('pyq');
    return { at: null, items: [] };
  });
}

export async function pyqSearch({ q = '', paper = '', year = '' } = {}) {
  const idx = await pyqIndex();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const items = idx.items.filter((x) => (!paper || x.paper.toLowerCase().startsWith(paper.toLowerCase()))
    && (!year || x.year === year) && terms.every((t) => `${x.title} ${x.paper} ${x.year}`.toLowerCase().includes(t)));
  return { items: items.slice(0, 60), total: items.length, indexedAt: idx.at, stale: !!idx.stale, official: CONFIG.upscPyqUrl,
    years: [...new Set(idx.items.map((x) => x.year).filter(Boolean))].sort().reverse() };
}

// ------------------------------------------------------------------ rate limit + static
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, at: now };
  if (now - h.at > 60e3) { h.n = 0; h.at = now; }
  h.n++;
  hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.n > 120;
}

const fileCache = new Map();                              // path -> {mtime, buf, etag}
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/upsc-daily-study.html';
  const full = normalize(join(CONFIG.publicDir, rel));
  if (!full.startsWith(CONFIG.publicDir + sep)) return json(req, res, 400, { error: 'bad path' });
  let st;
  try { st = await stat(full); } catch { return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8'); }
  if (!st.isFile()) return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
  let f = fileCache.get(full);
  if (!f || f.mtime !== st.mtimeMs) {
    const buf = await readFile(full);
    f = { mtime: st.mtimeMs, buf, etag: `"${createHash('sha1').update(buf).digest('base64url').slice(0, 16)}"` };
    fileCache.set(full, f);
  }
  const type = TYPES[extname(full).toLowerCase()] || 'application/octet-stream';
  const extra = { ETag: f.etag, 'Cache-Control': /\.(woff2|png|svg|ico)$/.test(full) ? 'public, max-age=604800' : 'no-cache' };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, { ...HEADERS, ...extra }); return res.end(); }
  return send(req, res, 200, f.buf, type, extra);
}

export function handler() {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['GET', 'HEAD'].includes(req.method)) return json(req, res, 405, { error: 'method not allowed' });
      if (url.pathname.startsWith('/api/')) {
        if (limited(req.socket.remoteAddress || '')) return json(req, res, 429, { error: 'too many requests' });
        const p = Object.fromEntries([...url.searchParams].map(([k, v]) => [k, v.slice(0, 120)]));
        if (url.pathname === '/api/health') return json(req, res, 200, { ok: true, khoj: !!CONFIG.khojUrl });
        if (url.pathname === '/api/ca') return json(req, res, 200, await currentAffairs(p), { 'Cache-Control': 'no-store' });
        if (url.pathname === '/api/pyq') return json(req, res, 200, await pyqSearch(p), { 'Cache-Control': 'no-store' });
        return json(req, res, 404, { error: 'not found' });
      }
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(req, res, 500, { error: 'internal error' });
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer(handler()).listen(CONFIG.port, () => {
    console.log(`GYANAGI UPSC on http://localhost:${CONFIG.port}/upsc-daily-study.html${CONFIG.khojUrl ? ' (Khoj on)' : ''}`);
  });
}
