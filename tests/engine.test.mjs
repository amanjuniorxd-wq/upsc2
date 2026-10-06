import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as E from '../public/js/engine.mjs';

const data = JSON.parse(readFileSync(new URL('../public/data/upsc-data.json', import.meta.url)));
const D0 = new Date('2026-10-06T08:00:00Z');
const day = (n) => new Date(D0.getTime() + n * 86400000);
const fresh = (profile = { year: 2027, level: 'beginner', hours: 6, focus: 'both', medium: 'en' }) => ({ ...E.defaultState(), profile });

test('revision ladder: Day 0 / +1 / +3 / +7 / +14 / +30 / +60 for steady good recall', () => {
  let r = { step: 0, ease: 1, interval: 1 };
  const seen = [];
  for (let i = 0; i < 5; i++) { r = E.nextRevision(r.step, r.ease, r.interval, 0.8); seen.push(r.interval); }
  assert.deepEqual(seen, [3, 7, 14, 30, 60]);
});

test('revision adapts: poor -> shorter (tomorrow, weak), excellent -> longer, average -> same step shorter', () => {
  const poor = E.nextRevision(3, 1, 14, 0.3);
  assert.equal(poor.interval, 1); assert.equal(poor.weak, true); assert.ok(poor.ease < 1);
  const great = E.nextRevision(2, 1, 7, 0.95);
  assert.ok(great.interval > 14 && great.ease > 1);
  const avg = E.nextRevision(3, 1, 14, 0.6);
  assert.equal(avg.step, 3); assert.ok(avg.interval < 14);
});

test('revision buckets: high priority = weak or overdue >= 2 days; completed = reviewed today', () => {
  const s = fresh();
  E.scheduleTopic(s, 'pol-fr', day(-5));                      // due day -4 -> overdue
  E.scheduleTopic(s, 'eco-inflation', day(-1));               // due today
  E.reviewTopic(s, 'geo-indian', 0.9, day(0));                // reviewed today
  const b = E.revisionBuckets(s, day(0));
  assert.deepEqual(b.high.map((x) => x.id), ['pol-fr']);
  assert.deepEqual(b.normal.map((x) => x.id), ['eco-inflation']);
  assert.deepEqual(b.done.map((x) => x.id), ['geo-indian']);
  assert.equal(b.due, 2);
});

test('migrate keeps data, upgrades legacy array revision, and survives junk', () => {
  const legacy = { attempts: [{ qid: 'm1', topic: 'pol-fr', subject: 'polity', kind: 'prelims', c: 1, d: '2026-10-01' }], revision: [{ topic: 'pol-fr', due: '2026-10-07', step: 2 }] };
  const s = E.migrate(legacy);
  assert.equal(s.v, E.STATE_VERSION);
  assert.equal(s.attempts.length, 1);
  assert.equal(s.revision['pol-fr'].step, 2);
  assert.deepEqual(E.migrate('garbage').attempts, []);
  const store = new Map();
  const ls = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  ls.setItem(E.STORAGE_KEY, '{not json');
  assert.equal(E.loadState(ls).v, E.STATE_VERSION);
  E.saveState(ls, s);
  assert.equal(E.loadState(ls).revision['pol-fr'].due, '2026-10-07');
});

test('prelims stats, subject accuracy and biggest weakness', () => {
  const s = fresh();
  for (let i = 0; i < 4; i++) E.recordAttempt(s, { qid: `m${i}`, topic: 'eco-inflation', subject: 'economy', correct: i === 0 }, D0);
  for (let i = 0; i < 4; i++) E.recordAttempt(s, { qid: `p${i}`, topic: 'pol-fr', subject: 'polity', correct: true }, D0);
  E.recordAttempt(s, { qid: 'ca:m9', topic: 'pol-fr', subject: 'polity', correct: false }, D0);
  const st = E.prelimsStats(s, data);
  assert.equal(st.overall.attempts, 9);
  assert.equal(st.bySubject.economy.accuracy, 0.25);
  assert.equal(st.weakest.topic, 'eco-inflation');
  assert.equal(st.currentAffairs.attempts, 1);
});

test('recommend returns ONE topic with reasons; weak + overdue topic wins', () => {
  const s = fresh();
  for (let i = 0; i < 5; i++) E.recordAttempt(s, { qid: `m${i}`, topic: 'eco-inflation', subject: 'economy', correct: i === 0 }, D0);
  E.scheduleTopic(s, 'eco-inflation', day(-6));
  const r = E.recommend(s, data, D0, { 'eco-inflation': 2 });
  assert.equal(r.topicId, 'eco-inflation');
  const kinds = r.reasons.map((x) => x[0]);
  assert.ok(kinds.includes('weak') && kinds.includes('overdue') && kinds.includes('ca'));
  assert.deepEqual(E.recommend(s, data, D0, { 'eco-inflation': 2 }), r, 'deterministic');
});

test('recommend respects focus: prelims focus never suggests Ethics/Essay', () => {
  const s = fresh({ year: 2027, level: 'beginner', hours: 6, focus: 'prelims' });
  for (let i = 0; i < 30; i++) {
    const r = E.recommend(s, data, D0);
    assert.ok(data.topics.find((t) => t.id === r.topicId).papers.includes('prelims'));
    E.markStudied(s, r.topicId, D0);
  }
});

test('mission: 7 steps for "both", minutes sum to roughly the daily hours, prelims focus drops Mains', () => {
  const s = fresh();
  const m = E.mission(s, data, D0);
  assert.deepEqual(m.steps.map((x) => x.key), E.MISSION_STEPS);
  const sum = m.steps.reduce((a, x) => a + x.minutes, 0);
  assert.ok(Math.abs(sum - 360) <= 30, `sum ${sum}`);
  const p = E.mission(fresh({ year: 2027, hours: 4, focus: 'prelims' }), data, D0);
  assert.ok(!p.steps.some((x) => x.key === 'mains'));
  E.completeStep(s, D0, 'learn', 100);
  assert.equal(E.completedMinutes(s, D0), 100);
  assert.equal(E.mission(s, data, D0).next.key, 'source');
});

test('mains evaluation: identifies main weakness and rewards a better rewrite', () => {
  const q = data.mains.find((x) => x.t === 'pol-fr');
  const weak = E.evaluateMains('Article 21 is very important for people and the courts have done many things about it over the years in India.', q);
  assert.ok(weak.main);
  assert.ok(['dimensions', 'intro', 'short'].includes(weak.main.key));
  const good = E.evaluateMains(`Article 21 protects life and personal liberty and has become the source of many unenumerated rights.

In Maneka Gandhi (1978) the Supreme Court read "procedure established by law" as due process. Puttaswamy (2017) recognised privacy and Olga Tellis recognised livelihood.

- Environment and health have been read into the right to life.
- Education and dignity followed, with Article 21A added in 2002.

However, judicial activism has limits and raises concerns about the separation of powers.

Conclusion: thus Article 21 is the heart of Part III; the way forward is principled restraint with strong protection of liberty.`, q);
  assert.ok(good.score > weak.score);
  assert.ok(good.intro && good.conclusion && good.evidence >= 2);
  assert.ok(good.score <= q.m * 0.75);
});

test('mains "critically" demand requires both sides', () => {
  const q = { q: 'Critically examine the role of the Governor.', m: 10, wl: 150, k: [] };
  const oneSided = E.evaluateMains('The Governor is the constitutional head of the state.\n\nThe Governor acts on aid and advice under Article 163.\n\nThe office ensures continuity.\n\nConclusion: thus the office matters.', q);
  assert.equal(oneSided.weaknesses[0].key, 'demand');
});

test('current-affairs mapping is deterministic and never invents links', () => {
  const m = E.mapToTopic('RBI monetary policy committee keeps repo rate unchanged as CPI inflation eases', data);
  assert.ok(['eco-monetary', 'eco-inflation'].includes(m.topicId));
  assert.ok(m.papers.includes('GS-III') && m.papers.includes('Prelims'));
  assert.equal(E.mapToTopic('Cricket team wins the series', data), null);
  const hi = E.mapToTopic('सर्वोच्च न्यायालय ने मौलिक अधिकार और निजता का अधिकार पर निर्णय दिया', data);
  assert.equal(hi.topicId, 'pol-fr');
});

test('papersForTopic maps topics to official paper names', () => {
  const t = data.topics.find((x) => x.id === 'eco-inflation');
  assert.deepEqual(E.papersForTopic(t), ['Prelims GS-I', 'Mains GS-III']);
});

test('readiness: unstarted areas are null (not fake), weakest = first unstarted, scores move with activity', () => {
  const s = fresh();
  let R = E.readiness(s, data, D0);
  assert.equal(R.area.prelims, null);
  assert.equal(R.strongest, null);
  for (const q of data.mcq.slice(0, 20)) E.recordAttempt(s, { qid: q.id, topic: q.t, subject: data.topics.find((t) => t.id === q.t).s, correct: true }, D0);
  R = E.readiness(s, data, D0);
  assert.ok(R.area.prelims > 0 && R.area.prelims <= 100);
  assert.equal(R.strongest, 'prelims');
  assert.notEqual(R.weakest, 'prelims');
});

test('topic metadata has the Phase-4 fields', () => {
  const s = fresh();
  E.markStudied(s, 'pol-fr', D0);
  const m = E.topicMeta(s, data, D0, { 'pol-fr': 3 })['pol-fr'];
  for (const k of ['mastery', 'mcqAccuracy', 'lastStudied', 'revisionDue', 'pyqCount', 'currentAffairsCount']) assert.ok(k in m, k);
  assert.equal(m.currentAffairsCount, 3);
  assert.equal(m.lastStudied, '2026-10-06');
  assert.ok(m.mastery > 0);
});

test('content: every syllabus area in the brief exists with Hindi', () => {
  const names = data.topics.map((t) => t.n);
  for (const n of ['Fundamental Rights', 'Parliament', 'Judiciary', 'Federalism', 'Local Government', 'Constitutional Bodies', 'Governance',
    'Ancient', 'Medieval', 'Modern', 'Freedom Struggle', 'Post Independence', 'Physical', 'Indian', 'World', 'Resources', 'Mapping',
    'Growth', 'Inflation', 'Banking', 'Monetary Policy', 'Fiscal Policy', 'Budget', 'External Sector', 'Ecology', 'Biodiversity', 'Climate Change',
    'Pollution', 'Conservation', 'Space', 'Biotechnology', 'AI', 'Defence Technology', 'Emerging Technology', 'Population', 'Poverty', 'Education',
    'Health', 'Social Issues', 'India & Neighbours', 'Major Powers', 'International Organisations', 'Global Groupings', 'Constitution']) assert.ok(names.includes(n), n);
  assert.ok(data.topics.every((t) => t.nh && t.noteHi));
});
