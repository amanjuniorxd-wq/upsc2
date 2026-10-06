# GYANAGI — UPSC Daily Study

A UPSC preparation operating system: **PLAN → LEARN → CONNECT → PRACTISE → EVALUATE → REVISE → REPEAT**.
Open `/upsc-daily-study.html` and the page tells you what to study, why, what to practise, where you are weak and what to revise today.
English by default, full Hindi with one tap. Zero dependencies.

```bash
npm start                 # http://localhost:3000/upsc-daily-study.html  (Node 18+)
npm run build             # syntax + wiring + content checks, writes dist/
npm test                  # 23 tests: engine logic + server (mock Khoj / PIB / UPSC)
```

Optional real-browser walkthrough of every phase (desktop, mobile, Hindi):
`pip install playwright && python -m playwright install chromium && PORT=3999 node server.mjs & python tests/browser_check.py http://localhost:3999`

## What is on the page

| Section | What it does |
|---|---|
| **Command Center** | UPSC CSE year, days remaining (to late-May Prelims), planned vs completed study time today, overall preparation, revisions due. **Your Today's Mission**: Study → Source/NCERT → PYQ → Prelims Practice → Mains Answer → Revision → CSAT, with minutes from your daily hours. **START TODAY'S PLAN** walks you through the real sections with a step bar. |
| **Study profile** | Shown once: attempt year, level, daily hours, optional, medium (English / Hindi / Bilingual), focus (Prelims / Mains / Both). Stored on the device only. |
| **What should I study now?** | One topic, with the reasons that picked it (weak accuracy, overdue revision, PYQ frequency, related current affairs, not yet studied). Transparent, deterministic scoring; no AI call. |
| **Teach Me** | Understand → UPSC angle → Source (NCERT) → PYQ → Prelims question → Mains question → Revision. |
| **Syllabus graph** | 11 subjects, 51 topics, each with mastery, MCQ accuracy, last studied, revision due, PYQs opened and current-affairs count. |
| **Prelims Practice** | Mixed / this topic / weak-area sets with answer review; accuracy overall and by subject; **biggest weakness** with one-tap practice. Finished sets update revision. |
| **PYQs** | Official UPSC papers only (indexed from upsc.gov.in, opened on the official site), filtered to the papers relevant to the topic, then related practice → Mains → add to revision. |
| **Mains Answer Lab** | Question → word limit → write → submit → evaluate → **main weakness** (missed demand, dimensions, intro, examples, conclusion, length) → **rewrite** with the previous score shown. |
| **Revision** | Revision due today; High priority / Normal / Completed. Day 0 → +1 → +3 → +7 → +14 → +30 → +60, shortened after poor recall and stretched after excellent recall. |
| **Current Affairs** | Khoj search across 8 UPSC areas → fallback to the PIB official feed → last saved results. Each card: title, 30-word preview, source, UPSC relevance (GS paper / Prelims) from keyword mapping, Related topic, Practise, Add to revision. |
| **CSAT** | Comprehension, Logical reasoning, Numeracy, Data interpretation; accuracy, weakest area, attempted, correct. |
| **UPSC Readiness** | Prelims, Mains, CSAT, Revision, Current Affairs, Answer Writing; areas with no activity show "Not started" instead of a made-up number. Strongest, weakest, next priority. The formula is shown on the page. |

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `KHOJ_URL`, `KHOJ_API_KEY` | — | Khoj server for current affairs (`/api/search`), queried in parallel for 8 areas |
| `PIB_RSS_URL` | PIB English releases | Current-affairs fallback |
| `UPSC_PYQ_URL`, `UPSC_PYQ_PAGES` | upsc.gov.in previous-question-papers, 25 | Official paper index source |
| `CACHE_DIR` | `.cache` | Last-good current affairs and the 24-hour PYQ index |
| `PUBLIC_DIR` | `public` | Use `dist` after `npm run build` |

## Files

| Path | What |
|---|---|
| `public/upsc-daily-study.html` | The app (markup, styles, UI and Hindi strings) |
| `public/js/engine.mjs` | Pure study logic: state + migration, planner/mission, recommendation, revision, stats, readiness, Mains rubric, CA mapping |
| `public/data/upsc-data.json` | Content: syllabus graph and notes (EN + HI), 89 MCQs, 51 Mains questions, 16 CSAT questions |
| `server.mjs` | Static server (gzip, ETag) + `/api/ca`, `/api/pyq`, `/api/health` |
| `scripts/build.mjs`, `tests/` | Build checks and tests |

**Adding questions:** append to `mcq`, `mains` or `csat` in `public/data/upsc-data.json` using the same fields. `npm run build` validates answers, topics and Hindi.

**Saved data:** everything a student does is one localStorage record, `gyanagi.upsc.v1`, with versioned migration (`engine.migrate`). Older records are upgraded, not dropped.
