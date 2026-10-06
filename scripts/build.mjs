// Build = verify + bundle (no dependencies).
// 1. syntax-check server.mjs, the engine and the inline <script type="module"> of every HTML page
// 2. check that every getElementById/#id selector used in the page exists, every data-act has a handler,
//    and every handler is used; check that local href/src targets exist
// 3. validate the content JSON (shape, answer indexes, topic references, Hindi coverage)
// 4. write dist/ (public/ copied as-is, ready to serve with `PUBLIC_DIR=dist node server.mjs`)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUB = join(ROOT, 'public');
const errors = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { errors.push(m); console.log(`  ✗ ${m}`); };

function nodeCheck(file, label = file) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); ok(`syntax ${label}`); }
  catch (e) { fail(`syntax ${label}: ${String(e.stderr || e.message).split('\n').slice(0, 4).join(' ')}`); }
}

console.log('1. syntax');
nodeCheck(join(ROOT, 'server.mjs'), 'server.mjs');
nodeCheck(join(PUB, 'js', 'engine.mjs'), 'public/js/engine.mjs');
const pages = readdirSync(PUB).filter((f) => f.endsWith('.html'));
const tmp = join(tmpdir(), `gyanagi-build-${process.pid}`);
mkdirSync(tmp, { recursive: true });
for (const page of pages) {
  const html = readFileSync(join(PUB, page), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc=/.test(m[1]));
  scripts.forEach((m, i) => {
    const f = join(tmp, `${page}.${i}.mjs`);
    writeFileSync(f, m[2]);
    nodeCheck(f, `${page} inline script #${i + 1}`);
  });

  console.log(`2. wiring: ${page}`);
  const js = scripts.map((m) => m[2]).join('\n');
  const ids = new Set([...html.matchAll(/\bid="([^"$]+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/(?:getElementById\(['"]|\$\(\s*['"]#)([A-Za-z][\w-]*)/g)) if (!ids.has(m[1])) fail(`${page}: #${m[1]} is referenced but no element has that id`);
  const used = new Set([...html.matchAll(/data-act="([\w-]+)"/g)].map((m) => m[1]));
  const actBlock = js.slice(js.indexOf('const ACT = {'), js.indexOf('\n};', js.indexOf('const ACT = {')));
  const handlers = new Set([...actBlock.matchAll(/^\s{2}(?:'([\w-]+)'|(\w+))\s*\(/gm)].map((m) => m[1] || m[2]));
  const fieldActs = new Set(['teach-select', 'pyq-filter-paper', 'pyq-filter-year', 'ca-search', 'pyq-search']);
  for (const a of used) if (!handlers.has(a) && !fieldActs.has(a)) fail(`${page}: data-act="${a}" has no handler`);
  for (const h of handlers) if (!used.has(h)) fail(`${page}: handler ${h} is never used by a button`);
  for (const f of fieldActs) if (used.has(f) && !js.includes(`'${f}'`)) fail(`${page}: field action ${f} is not handled`);
  for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*|\.\/[^"#?]*)"/g)) {
    const p = m[1].startsWith('./') ? join(PUB, m[1].slice(2)) : join(PUB, m[1]);
    if (m[1] !== '/' && !existsSync(p)) fail(`${page}: ${m[1]} does not exist`);
  }
  for (const m of js.matchAll(/from '\.\/([^']+)'/g)) if (!existsSync(join(PUB, m[1]))) fail(`${page}: import ./${m[1]} missing`);
  if (!errors.length) ok(`${used.size} actions wired, ${ids.size} ids`);
}
rmSync(tmp, { recursive: true, force: true });

console.log('3. content');
const data = JSON.parse(readFileSync(join(PUB, 'data', 'upsc-data.json'), 'utf8'));
const topics = new Set(data.topics.map((t) => t.id));
const subjects = new Set(data.subjects.map((s) => s.id));
for (const t of data.topics) {
  if (!subjects.has(t.s)) fail(`topic ${t.id}: unknown subject ${t.s}`);
  if (!t.note || !t.noteHi || !t.n || !t.nh) fail(`topic ${t.id}: missing English/Hindi name or note`);
  if (!t.kw?.length) fail(`topic ${t.id}: no keywords for current-affairs mapping`);
}
for (const q of [...data.mcq, ...data.csat]) {
  if (q.o?.length !== 4 || !(q.a >= 0 && q.a < 4)) fail(`question ${q.id}: needs 4 options and a valid answer`);
  if (q.oh && q.oh.length !== 4) fail(`question ${q.id}: Hindi options must be 4`);
  if (!q.qh) fail(`question ${q.id}: missing Hindi text`);
}
for (const q of data.mcq) if (!topics.has(q.t)) fail(`mcq ${q.id}: unknown topic ${q.t}`);
for (const q of data.mains) if (!topics.has(q.t) || !q.wl || !q.m) fail(`mains ${q.id}: bad topic/marks/word limit`);
const cats = new Set(data.csat.map((q) => q.c));
for (const c of ['comprehension', 'reasoning', 'numeracy', 'di']) if (!cats.has(c)) fail(`csat: no ${c} questions`);
const ids = [...data.mcq, ...data.mains, ...data.csat].map((q) => q.id);
if (new Set(ids).size !== ids.length) fail('duplicate question ids');
ok(`${data.subjects.length} subjects, ${data.topics.length} topics, ${data.mcq.length} MCQs, ${data.mains.length} Mains, ${data.csat.length} CSAT`);

console.log('4. dist');
if (errors.length) {
  console.error(`\nBuild failed with ${errors.length} error(s).`);
  process.exit(1);
}
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
cpSync(PUB, join(ROOT, 'dist'), { recursive: true });
ok('dist/ written');
console.log('\nBuild OK');
