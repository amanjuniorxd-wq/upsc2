// GYANAGI UPSC engine — pure, deterministic study logic shared by the page and the tests.
// No DOM access here. All state lives in one localStorage record (see STORAGE_KEY), migrated by version.

export const STORAGE_KEY = 'gyanagi.upsc.v1';
export const STATE_VERSION = 2;
export const LADDER = [1, 3, 7, 14, 30, 60];
const DAY = 86400000;

export const iso = (d) => new Date(d).toISOString().slice(0, 10);
export const addDays = (d, n) => iso(new Date(`${iso(d)}T00:00:00Z`).getTime() + n * DAY);
export const daysBetween = (a, b) => Math.round((new Date(`${iso(b)}T00:00:00Z`) - new Date(`${iso(a)}T00:00:00Z`)) / DAY);
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

// ------------------------------------------------------------------ state
export function defaultState() {
  return { v: STATE_VERSION, lang: 'en', profile: null, attempts: [], mains: [], revision: {}, studied: {}, log: {},
    mission: {}, ca: { saved: [], seen: {} }, pyqOpened: {} };
}

/** Upgrade any older/partial record without dropping user data. */
export function migrate(raw) {
  const s = { ...defaultState(), ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!raw || !raw.v) {
    // v1 (pre-release) stored revision as an array of {topic, due, step}
    if (Array.isArray(raw?.revision)) {
      s.revision = {};
      for (const r of raw.revision) if (r?.topic) s.revision[r.topic] = { step: r.step || 0, ease: 1, interval: 1, due: r.due, last: null, weak: false, hist: [] };
    }
  }
  for (const k of ['attempts', 'mains']) if (!Array.isArray(s[k])) s[k] = [];
  for (const k of ['revision', 'studied', 'log', 'mission', 'pyqOpened']) if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) s[k] = {};
  if (!s.ca || typeof s.ca !== 'object') s.ca = { saved: [], seen: {} };
  s.ca.saved ||= []; s.ca.seen ||= {};
  if (s.attempts.length > 3000) s.attempts = s.attempts.slice(-3000);      // keep storage small
  if (s.mains.length > 300) s.mains = s.mains.slice(-300);
  s.v = STATE_VERSION;
  return s;
}

export function loadState(storage) {
  try { return migrate(JSON.parse(storage.getItem(STORAGE_KEY) || 'null')); } catch { return defaultState(); }
}
export function saveState(storage, s) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(s)); return true; } catch { return false; }
}

// ------------------------------------------------------------------ profile & exam dates
export function examDate(profile) {
  if (profile?.examDate) return profile.examDate;
  return `${profile?.year || new Date().getFullYear() + 1}-05-25`;      // Prelims is usually held in late May
}
export function plannedMinutes(profile) { return Math.round(clamp(Number(profile?.hours) || 6, 1, 16) * 60); }

export function logMinutes(s, today, minutes, kind) {
  const d = iso(today);
  s.log[d] ||= { total: 0 };
  s.log[d].total += Math.max(0, Math.round(minutes));
  s.log[d][kind] = (s.log[d][kind] || 0) + Math.round(minutes);
}
export const completedMinutes = (s, today) => s.log[iso(today)]?.total || 0;

// ------------------------------------------------------------------ revision (Day 0 / +1 / +3 / +7 / +14 / +30 / +60, adaptive)
/** Pure: (step, ease, interval, quality 0..1) -> next state. */
export function nextRevision(step, ease, interval, q) {
  if (q < 0.5) return { step: 0, ease: Math.max(0.6, +(ease - 0.15).toFixed(2)), interval: 1, weak: true };
  if (q < 0.75) {
    const base = LADDER[Math.min(step, LADDER.length - 1)];
    return { step, ease: Math.max(0.6, +(ease - 0.05).toFixed(2)), interval: Math.max(1, Math.round(base * ease * 0.7)), weak: false };
  }
  const e = q >= 0.9 ? Math.min(1.6, +(ease + 0.1).toFixed(2)) : ease;
  const ns = step + 1;
  if (ns < LADDER.length) return { step: ns, ease: e, interval: Math.max(1, Math.round(LADDER[ns] * e)), weak: false };
  return { step: ns, ease: e, interval: Math.min(180, Math.round(Math.max(interval, 60) * 1.5 * e)), weak: false };
}

export function scheduleTopic(s, topicId, today) {
  if (!s.revision[topicId]) s.revision[topicId] = { step: 0, ease: 1, interval: 1, due: addDays(today, 1), last: null, weak: false, hist: [], added: iso(today) };
  return s.revision[topicId];
}

export function reviewTopic(s, topicId, quality, today) {
  const r = scheduleTopic(s, topicId, today);
  const n = nextRevision(r.step, r.ease, r.interval, clamp(quality));
  Object.assign(r, n, { due: addDays(today, n.interval), last: iso(today), lastQ: +clamp(quality).toFixed(2) });
  r.hist = [...(r.hist || []).slice(-19), { d: iso(today), q: +clamp(quality).toFixed(2), i: n.interval }];
  return r;
}

export function revisionBuckets(s, today) {
  const t = iso(today);
  const high = []; const normal = []; const done = [];
  for (const [id, r] of Object.entries(s.revision)) {
    if (r.last === t) done.push({ id, ...r });
    else if (r.due <= t) {
      const overdue = daysBetween(r.due, t);
      (r.weak || overdue >= 2 ? high : normal).push({ id, ...r, overdue });
    }
  }
  high.sort((a, b) => b.overdue - a.overdue);
  normal.sort((a, b) => a.due.localeCompare(b.due));
  return { high, normal, done, due: high.length + normal.length };
}

// ------------------------------------------------------------------ practice records
export function recordAttempt(s, { qid, topic, subject, kind = 'prelims', correct }, today) {
  s.attempts.push({ qid, topic, subject, kind, c: correct ? 1 : 0, d: iso(today) });
}

function agg(list) {
  const n = list.length; const c = list.reduce((a, x) => a + x.c, 0);
  return { attempts: n, correct: c, incorrect: n - c, accuracy: n ? c / n : null };
}

export function prelimsStats(s, data) {
  const p = s.attempts.filter((a) => a.kind === 'prelims');
  const bySubject = {}; const byTopic = {};
  for (const sub of data.subjects) bySubject[sub.id] = agg(p.filter((a) => a.subject === sub.id));
  for (const t of data.topics) byTopic[t.id] = agg(p.filter((a) => a.topic === t.id));
  const ca = agg(p.filter((a) => a.qid?.startsWith('ca:')));
  const recent = agg(p.slice(-20));
  let weakest = null;
  for (const t of data.topics) {
    const g = byTopic[t.id];
    if (g.attempts >= 3 && (!weakest || g.accuracy < weakest.accuracy || (g.accuracy === weakest.accuracy && g.attempts > weakest.attempts))) weakest = { topic: t.id, ...g };
  }
  return { overall: agg(p), recent, bySubject, byTopic, currentAffairs: ca, weakest };
}

export const CSAT_CATS = ['comprehension', 'reasoning', 'numeracy', 'di'];
export function csatStats(s) {
  const c = s.attempts.filter((a) => a.kind === 'csat');
  const byCat = Object.fromEntries(CSAT_CATS.map((k) => [k, agg(c.filter((a) => a.topic === k))]));
  let weakest = null;
  for (const k of CSAT_CATS) {
    const g = byCat[k];
    if (g.attempts && (!weakest || g.accuracy < byCat[weakest].accuracy)) weakest = k;
  }
  return { ...agg(c), byCat, weakest };
}

// ------------------------------------------------------------------ topic metadata (Phase 4)
export function topicMeta(s, data, today, caCounts = {}) {
  const st = prelimsStats(s, data);
  const out = {};
  for (const t of data.topics) {
    const g = st.byTopic[t.id];
    const r = s.revision[t.id];
    const studied = s.studied[t.id];
    const mainsScores = s.mains.filter((m) => m.topic === t.id).map((m) => m.score / m.max);
    const parts = [];
    if (studied) parts.push(0.3);
    if (g.attempts) parts.push(0.4 * g.accuracy * clamp(g.attempts / 5));
    if (r) parts.push(0.2 * clamp(r.step / LADDER.length));
    if (mainsScores.length) parts.push(0.1 * clamp(mainsScores.reduce((a, b) => a + b, 0) / mainsScores.length / 0.75));
    out[t.id] = {
      mastery: Math.round(100 * parts.reduce((a, b) => a + b, 0)),
      mcqAccuracy: g.accuracy,
      mcqAttempts: g.attempts,
      lastStudied: studied?.last || null,
      revisionDue: r ? r.due : null,
      pyqCount: s.pyqOpened[t.id] || 0,
      currentAffairsCount: caCounts[t.id] || 0,
    };
  }
  return out;
}

// ------------------------------------------------------------------ "What should I study now?" (Phase 3)
/** Transparent deterministic score; returns one topic and the reasons that drove it. */
export function recommend(s, data, today, caCounts = {}) {
  const t = iso(today);
  const prof = s.profile || {};
  const focus = prof.focus || 'both';
  const st = prelimsStats(s, data);
  let best = null;
  for (const topic of data.topics) {
    if (topic.s === 'ethics' && focus === 'prelims') continue;
    if (focus === 'prelims' && !topic.papers.includes('prelims')) continue;
    if (focus === 'mains' && !topic.papers.some((p) => p.startsWith('gs') || p === 'essay')) continue;
    if (s.studied[topic.id]?.last === t) continue;                       // already done today
    const g = st.byTopic[topic.id];
    const r = s.revision[topic.id];
    const reasons = [];
    let score = 0;
    if (g.attempts >= 3 && g.accuracy < 0.6) { score += 2.2 * (1 - g.accuracy); reasons.push(['weak', Math.round(g.accuracy * 100)]); }
    if (r && r.due <= t) {
      const od = daysBetween(r.due, t);
      score += 1.6 + clamp(od / 7) * 1.2 + (r.weak ? 0.6 : 0);
      reasons.push(od > 0 ? ['overdue', od] : ['dueToday']);
    }
    score += 0.45 * (topic.w / 5) + 0.25 * (topic.imp / 5);
    if (topic.w >= 4.5) reasons.push(['pyq']);
    if (caCounts[topic.id]) { score += 0.3 * clamp(caCounts[topic.id] / 3); reasons.push(['ca', caCounts[topic.id]]); }
    const last = s.studied[topic.id]?.last;
    if (!last) { score += 0.5; reasons.push(['new']); } else score += 0.4 * clamp(daysBetween(last, t) / 21);
    if (prof.level === 'beginner' && topic.imp >= 5 && !last) score += 0.2;
    if (prof.level === 'revision' && r) score += 0.3;
    const key = `${score.toFixed(4)}|${topic.id}`;
    if (!best || score > best.score || (score === best.score && topic.id < best.topic.id)) best = { topic, score, reasons, key };
  }
  return best && { topicId: best.topic.id, score: +best.score.toFixed(2), reasons: best.reasons.slice(0, 4) };
}

// ------------------------------------------------------------------ Today's mission (Phase 1)
export const MISSION_STEPS = ['learn', 'source', 'pyq', 'prelims', 'mains', 'revision', 'csat'];
export function mission(s, data, today, caCounts = {}) {
  const prof = s.profile || {};
  const total = plannedMinutes(prof);
  const w = { learn: 0.28, source: 0.14, pyq: 0.1, prelims: 0.16, mains: 0.12, revision: 0.12, csat: 0.08 };
  if (prof.focus === 'prelims') { w.prelims += w.mains; w.mains = 0; }
  if (prof.focus === 'mains') { w.mains += w.csat + 0.06; w.csat = 0; w.prelims -= 0.06; }
  if (prof.level === 'revision') { w.revision += 0.1; w.learn -= 0.1; }
  const rec = recommend(s, data, today, caCounts);
  const done = new Set(s.mission[iso(today)]?.done || []);
  const steps = MISSION_STEPS.filter((k) => w[k] > 0).map((k) => ({ key: k, minutes: Math.max(10, Math.round((total * w[k]) / 5) * 5), done: done.has(k) }));
  const next = steps.find((x) => !x.done) || null;
  return { topicId: rec?.topicId || null, steps, next, total, doneCount: steps.filter((x) => x.done).length };
}
export function completeStep(s, today, key, minutes) {
  const d = iso(today);
  s.mission[d] ||= { done: [], topic: null };
  if (!s.mission[d].done.includes(key)) { s.mission[d].done.push(key); logMinutes(s, today, minutes, key); }
  // keep only the last 60 days of mission history
  const keys = Object.keys(s.mission).sort();
  while (keys.length > 60) delete s.mission[keys.shift()];
}

export function markStudied(s, topicId, today) {
  const r = s.studied[topicId] || { count: 0 };
  s.studied[topicId] = { count: r.count + 1, first: r.first || iso(today), last: iso(today) };
  scheduleTopic(s, topicId, today);
}

// ------------------------------------------------------------------ Mains evaluation (Phase 8) — transparent rubric
const DEVANAGARI = /[ऀ-ॿ]/;
const DEMAND = [
  { re: /critically|आलोचनात्मक/i, key: 'critically' },
  { re: /\bexamine|परीक्षण/i, key: 'examine' },
  { re: /\bevaluate|\bassess|मूल्यांकन|आकलन/i, key: 'evaluate' },
  { re: /\bdiscuss|चर्चा|विवेचना/i, key: 'discuss' },
  { re: /\bexplain|\belucidate|स्पष्ट|समझाइए/i, key: 'explain' },
];
const BALANCE = /\b(however|but|on the other hand|limitations?|criticism|concerns?|challenges?|drawbacks?)\b|हालाँकि|किंतु|परंतु|दूसरी ओर|सीमाएँ|चुनौतियाँ|आलोचना/i;
const CONCL = /\b(conclusion|way forward|thus|therefore|hence|in sum|going forward|to conclude)\b|निष्कर्ष|आगे की राह|अतः|इसलिए|अंततः/i;
const EVIDENCE = /\b(19|20)\d{2}\b|\barticle\s*\d+|\bsection\s*\d+|\bcase\b|\bcommittee\b|\bcommission\b|\breport\b|\bindex\b|\bsurvey\b|\bact\b|\bscheme\b|%|अनुच्छेद\s*\d+|समिति|आयोग|रिपोर्ट|सूचकांक|सर्वेक्षण|अधिनियम|योजना/gi;

export function evaluateMains(answer, question) {
  const text = String(answer || '').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const paras = text.split(/\n\s*\n|\n(?=\s*[-•*\d])/).map((p) => p.trim()).filter(Boolean);
  const low = text.toLowerCase();
  const kp = question.k || [];
  const covered = []; const missed = [];
  for (const k of kp) {
    const toks = k.toLowerCase().split(/[^a-z0-9ऀ-ॿ]+/).filter((x) => x.length > 2);
    const hit = toks.length && (toks.every((x) => low.includes(x)) || (toks.length > 1 && toks.filter((x) => low.includes(x)).length >= toks.length - 1));
    (hit ? covered : missed).push(k);
  }
  const hindi = DEVANAGARI.test(text);
  // Hindi answers cannot be matched against English key points; judge dimensions by structure and length instead.
  const coverage = kp.length && !hindi ? covered.length / kp.length : clamp(paras.length / 6) * clamp(words / (question.wl || 150));
  const intro = paras.length >= 2 && paras[0].split(/\s+/).length <= 90;
  const conclusion = paras.length >= 3 && CONCL.test(paras[paras.length - 1]);
  const evidence = (text.match(EVIDENCE) || []).length;
  const demand = DEMAND.find((d) => d.re.test(question.q || '') || d.re.test(question.qh || ''))?.key || 'discuss';
  const balanced = BALANCE.test(text);
  const ratio = words / (question.wl || 150);
  const lengthScore = ratio >= 0.8 && ratio <= 1.2 ? 1 : clamp(1 - Math.abs(1 - ratio));
  const structure = (intro ? 0.35 : 0) + (conclusion ? 0.35 : 0) + clamp(paras.length / 4) * 0.3;
  const presentation = clamp(0.3 + 0.12 * evidence + (paras.length >= 4 ? 0.2 : 0));
  const demandMet = !['critically', 'evaluate', 'examine'].includes(demand) || balanced;
  const total = 0.45 * coverage + 0.2 * structure + 0.15 * lengthScore + 0.15 * presentation + 0.05 * (demandMet ? 1 : 0);
  const max = question.m || 15;
  const score = +(total * max * 0.75).toFixed(1);                        // strong UPSC answers score ~60–75%
  const weaknesses = [];
  if (!demandMet) weaknesses.push({ key: 'demand', sev: 5, demand });
  if (coverage < 0.4) weaknesses.push({ key: 'dimensions', sev: 4, missed: missed.slice(0, 6) });
  if (!intro) weaknesses.push({ key: 'intro', sev: 3 });
  if (evidence < 2) weaknesses.push({ key: 'examples', sev: 3 });
  if (!conclusion) weaknesses.push({ key: 'conclusion', sev: 2 });
  if (ratio < 0.7) weaknesses.push({ key: 'short', sev: 3, words });
  else if (ratio > 1.3) weaknesses.push({ key: 'long', sev: 1, words });
  weaknesses.sort((a, b) => b.sev - a.sev);
  return { score, max, words, coverage: +coverage.toFixed(2), covered, missed, intro, conclusion, evidence, demand,
    balanced, weaknesses, main: weaknesses[0] || null };
}

export function recordMains(s, { qid, topic, score, max, words, main }, today, minutes) {
  s.mains.push({ qid, topic, score, max, words, main: main?.key || null, d: iso(today) });
  if (minutes) logMinutes(s, today, minutes, 'mains');
  return reviewTopic(s, topic, clamp(score / (max * 0.75)), today);
}

// ------------------------------------------------------------------ Current affairs mapping (Phase 6)
const GS_OF = { polity: 'GS-II', ir: 'GS-II', society: 'GS-I', history: 'GS-I', culture: 'GS-I', geography: 'GS-I',
  economy: 'GS-III', environment: 'GS-III', science: 'GS-III', security: 'GS-III', ethics: 'GS-IV' };
const reCache = new Map();
function kwRe(k) {
  let re = reCache.get(k);
  if (!re) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = DEVANAGARI.test(k) ? new RegExp(esc) : new RegExp(`\\b${esc}\\b`, 'i');
    reCache.set(k, re);
  }
  return re;
}
/** Deterministic keyword mapping. Returns null when nothing in the syllabus graph matches (no fabricated links). */
export function mapToTopic(text, data) {
  let best = null;
  for (const t of data.topics) {
    let n = 0; const hits = [];
    for (const k of t.kw) if (kwRe(k).test(text)) { n += k.includes(' ') ? 2 : 1; hits.push(k); }
    if (n >= 2 && (!best || n > best.n)) best = { topicId: t.id, subject: t.s, n, hits };
  }
  if (!best) return null;
  const topic = data.topics.find((x) => x.id === best.topicId);
  const papers = [...new Set([GS_OF[best.subject], topic.papers.includes('prelims') ? 'Prelims' : null].filter(Boolean))];
  return { ...best, papers };
}
export function caCountsFrom(items, data) {
  const c = {};
  for (const it of items) { const m = mapToTopic(`${it.title} ${it.summary || ''}`, data); if (m) c[m.topicId] = (c[m.topicId] || 0) + 1; }
  return c;
}

// ------------------------------------------------------------------ PYQ mapping (Phase 7): topic -> official papers
export function papersForTopic(topic) {
  const out = [];
  if (topic.papers.includes('prelims')) out.push('Prelims GS-I');
  for (const p of topic.papers) {
    const m = /^gs([1-4])$/.exec(p);
    if (m) out.push(`Mains GS-${['I', 'II', 'III', 'IV'][+m[1] - 1]}`);
    if (p === 'essay') out.push('Essay');
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------------ UPSC readiness (Phase 11)
export function readiness(s, data, today, caCounts = {}) {
  const t = iso(today);
  const st = prelimsStats(s, data);
  const withMcq = new Set(data.mcq.map((q) => q.t));
  const attemptedTopics = Object.entries(st.byTopic).filter(([id, g]) => withMcq.has(id) && g.attempts >= 2).length;
  const coverage = attemptedTopics / Math.max(1, withMcq.size);
  const area = {};
  area.prelims = st.overall.attempts ? Math.round(100 * (0.65 * st.overall.accuracy * clamp(st.overall.attempts / 40) + 0.35 * coverage)) : null;
  const cs = csatStats(s);
  area.csat = cs.attempts ? Math.round(100 * cs.accuracy * clamp(cs.attempts / 16)) : null;
  const scores = s.mains.map((m) => m.score / (m.max * 0.75));
  area.mains = scores.length ? Math.round(100 * clamp(scores.reduce((a, b) => a + b, 0) / scores.length) * clamp(scores.length / 5)) : null;
  const recent = s.mains.filter((m) => daysBetween(m.d, t) <= 13).length;
  area.answerWriting = s.mains.length ? Math.round(100 * clamp(recent / 7)) : null;
  const sched = Object.values(s.revision);
  const overdue = sched.filter((r) => r.due < t).length;
  area.revision = sched.length ? Math.round(100 * (1 - overdue / sched.length)) : null;
  const caWeek = Object.entries(s.ca.seen).filter(([, d]) => daysBetween(d, t) <= 6).length + s.ca.saved.filter((x) => daysBetween(x.d, t) <= 6).length;
  area.currentAffairs = Object.keys(s.ca.seen).length || s.ca.saved.length ? Math.round(100 * clamp(caWeek / 10)) : null;
  const scored = Object.entries(area).filter(([, v]) => v !== null);
  const strongest = scored.length ? scored.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null;
  const unstarted = Object.entries(area).find(([, v]) => v === null)?.[0];
  const weakest = unstarted || (scored.length ? scored.reduce((a, b) => (b[1] < a[1] ? b : a))[0] : null);
  return { area, strongest, weakest, next: weakest, basis: { coverage: +coverage.toFixed(2), prelimsAttempts: st.overall.attempts, csatAttempts: cs.attempts, mainsAnswers: s.mains.length, revisionScheduled: sched.length, overdue, caThisWeek: caWeek } };
}

// ------------------------------------------------------------------ overall preparation progress
export function overallProgress(s, data) {
  const meta = topicMeta(s, data, new Date());
  const vals = data.topics.map((t) => meta[t.id].mastery);
  return Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length));
}

/** Seeded shuffle so a set is stable within a day but varies across days. */
export function seededPick(list, n, seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; const j = h % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, n);
}
