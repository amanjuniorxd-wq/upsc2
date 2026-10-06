import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// local mocks for Khoj, PIB RSS and the UPSC archive
const mock = { khojFail: false, pibFail: false, upscFail: false, khojHits: 0 };
const RSS = `<rss><channel>
<item><title>RBI Monetary Policy Committee keeps repo rate unchanged; CPI inflation eases</title><link>https://pib.gov.in/a</link><description><![CDATA[The MPC retained the <b>repo rate</b> and inflation target.]]></description><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Tiger reserve notified; wildlife corridor and forest conservation plan</title><link>https://pib.gov.in/b</link><description>Wildlife and forest.</description></item>
<item><title>RBI Monetary Policy Committee keeps repo rate unchanged; CPI inflation eases</title><link>https://pib.gov.in/a</link></item>
</channel></rss>`;
const UPSC = (p) => p === '0' || p === null
  ? `<a href="/sites/default/files/QP-CSP-24-GS-I.pdf">Civil Services (Preliminary) Examination, 2024 General Studies Paper I</a>
     <a href="/sites/default/files/QP-CSP-24-GS-II.pdf">Civil Services (Preliminary) Examination, 2024 General Studies Paper II</a>
     <a href="/sites/default/files/ESE-24.pdf">Engineering Services 2024</a>`
  : p === '1' ? `<a href="/sites/default/files/QP-CSM-23-GS-III.pdf">Civil Services (Main) Examination 2023 General Studies Paper III</a>
     <a href="/sites/default/files/QP-CSM-23-Essay.pdf">Civil Services (Main) Examination 2023 Essay</a>` : '<p>no more</p>';
let mockSrv; let base;
let srv; let app;
let cacheDir;

before(async () => {
  mockSrv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/search') {
      mock.khojHits++;
      if (mock.khojFail) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ entry: 'Supreme Court on fundamental rights and Article 21 privacy. Long text here.', score: 0.9, additional: { file: 'https://example.org/sc-privacy', heading: 'SC on privacy' } }]));
    }
    if (u.pathname === '/rss') { if (mock.pibFail) { res.writeHead(503); return res.end(); } res.writeHead(200); return res.end(RSS); }
    if (u.pathname === '/pyq') { if (mock.upscFail) { res.writeHead(503); return res.end(); } res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(UPSC(u.searchParams.get('page'))); }
    res.writeHead(404); res.end();
  }).listen(0);
  await new Promise((r) => mockSrv.once('listening', r));
  base = `http://127.0.0.1:${mockSrv.address().port}`;
  cacheDir = mkdtempSync(join(tmpdir(), 'gy-cache-'));
  Object.assign(process.env, { KHOJ_URL: '', PIB_RSS_URL: `${base}/rss`, UPSC_PYQ_URL: `${base}/pyq`, UPSC_PYQ_PAGES: '4', CACHE_DIR: cacheDir, FETCH_TIMEOUT_MS: '3000' });
  app = await import('../server.mjs');
  srv = createServer(app.handler()).listen(0);
  await new Promise((r) => srv.once('listening', r));
});
after(() => { srv.close(); mockSrv.close(); rmSync(cacheDir, { recursive: true, force: true }); });

const url = (p) => `http://127.0.0.1:${srv.address().port}${p}`;
const getJson = async (p) => { const r = await fetch(url(p)); assert.equal(r.status, 200); return r.json(); };

test('serves the study page at / and /upsc-daily-study.html with security headers and gzip', async () => {
  for (const p of ['/', '/upsc-daily-study.html']) {
    const r = await fetch(url(p));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await r.text(), /GYANAGI/);
  }
  const raw = await new Promise((resolve) => {
    import('node:http').then(({ get }) => get(url('/data/upsc-data.json'), { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    }));
  });
  assert.equal(raw.res.headers['content-encoding'], 'gzip');
  assert.ok(JSON.parse(gunzipSync(raw.body)).topics.length > 40);
});

test('ETag revalidation returns 304', async () => {
  const r = await fetch(url('/js/engine.mjs'));
  const etag = r.headers.get('etag');
  const r2 = await fetch(url('/js/engine.mjs'), { headers: { 'If-None-Match': etag } });
  assert.equal(r2.status, 304);
});

test('blocks path traversal and unknown methods', async () => {
  const r = await fetch(url('/..%2f..%2fserver.mjs'));
  assert.ok([400, 404].includes(r.status));
  const p = await fetch(url('/api/health'), { method: 'POST' });
  assert.equal(p.status, 405);
});

test('current affairs: PIB fallback when Khoj is not configured; dedupes; maps areas', async () => {
  const j = await getJson('/api/ca');
  assert.equal(j.source, 'pib');
  assert.equal(j.items.length, 2);
  assert.equal(j.items[0].area, 'economy');
  assert.ok(j.items[0].summary.split(' ').length <= 31);
  assert.equal(j.areas.length, 8);
  const env = await getJson('/api/ca?area=environment');
  assert.ok(env.items.every((x) => x.area === 'environment'));
});

test('current affairs: Khoj 8-area search when configured, cached fallback when everything is down', async () => {
  app.CONFIG.khojUrl = base;
  const j = await getJson('/api/ca?q=privacy');
  assert.equal(j.source, 'khoj');
  assert.equal(mock.khojHits, 8);                                  // one search per UPSC area, run in parallel
  assert.equal(j.items[0].url, 'https://example.org/sc-privacy');
  mock.khojFail = true; mock.pibFail = true;
  app.resetMemoryCache();
  const k = await getJson('/api/ca');
  assert.equal(k.source, 'cache');                                 // last good result from disk
  assert.ok(k.items.length > 0 && k.cachedAt);
  app.CONFIG.khojUrl = '';
  mock.khojFail = false; mock.pibFail = false;
});

test('PYQ: indexes only Civil Services PDFs across pages and classifies paper/year', async () => {
  const j = await getJson('/api/pyq');
  assert.equal(j.total, 4);
  assert.ok(!j.items.some((x) => /Engineering/.test(x.title)));
  const papers = j.items.map((x) => `${x.year} ${x.paper}`).sort();
  assert.deepEqual(papers, ['2023 Essay', '2023 Mains GS-III', '2024 Prelims CSAT (GS-II)', '2024 Prelims GS-I']);
  assert.ok(j.items.every((x) => x.url.startsWith(base)));
  const f = await getJson('/api/pyq?paper=Mains%20GS-III');
  assert.equal(f.total, 1);
  assert.deepEqual(j.years, ['2024', '2023']);
});

test('PYQ: serves the cached index when upsc.gov.in is unreachable', async () => {
  mock.upscFail = true;
  app.resetMemoryCache();                                          // force a rebuild attempt: must fall back to the disk cache
  const j = await getJson('/api/pyq?year=2024');
  assert.equal(j.total, 2);
  mock.upscFail = false;
});

test('unit: RSS parser, area classifier, paper classifier', () => {
  const items = app.parseRss(RSS);
  assert.equal(items[0].published, '2026-10-05');
  assert.equal(app.areaOf('He said the main point'), null);
  assert.equal(app.areaOf('ISRO launches satellite'), 'science');
  assert.deepEqual(app.classifyPaper('Civil Services (Main) 2022 General Studies Paper IV'), { year: '2022', paper: 'Mains GS-IV' });
});
