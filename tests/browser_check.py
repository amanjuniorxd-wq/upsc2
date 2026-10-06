"""Optional browser check (Playwright for Python + Chromium). Not needed to run the app.

    pip install playwright && python -m playwright install chromium
    PORT=3999 node server.mjs &   python tests/browser_check.py http://localhost:3999

Walks every phase in a real browser: profile, command center, recommendation, mission guide, Teach Me, syllabus graph,
Prelims Practice, PYQ, Mains lab + rewrite, revision, current affairs, CSAT, readiness, Hindi toggle, mobile layout,
localStorage persistence, and fails on any console error or dead button.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3999").rstrip("/")
SHOTS = os.environ.get("SHOTS")
errors = []


def shot(page, name):
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=False)


def has(page, sel, text):
    return text.lower() in page.inner_text(sel).lower()


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("  ✓", msg)


def run(p, width, height, tag):
    b = p.chromium.launch()
    ctx = b.new_context(viewport=dict(width=width, height=height))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"{tag} pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"{tag} console: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.goto(f"{BASE}/upsc-daily-study.html")
    page.wait_for_selector("#profileForm")
    check(page.evaluate("document.documentElement.lang") == "en", f"[{tag}] English is the default")
    shot(page, f"{tag}-01-profile")
    page.select_option("select[name=level]", "intermediate")
    page.fill("input[name=hours]", "6")
    page.select_option("select[name=optional]", "Sociology")
    page.click("#profileForm button[type=submit]")
    page.wait_for_selector("#command .steps")
    check(page.locator(".stat").first.inner_text().strip() != "", f"[{tag}] command center stats render")
    shot(page, f"{tag}-02-command")

    # Phase 3 — one recommendation with reasons
    page.click("[data-act=recommend]")
    page.wait_for_selector("#recCard .what")
    check(page.locator("#recCard ul.why li").count() >= 1, f"[{tag}] recommendation shows reasons")
    shot(page, f"{tag}-03-recommend")

    # Phase 1 — mission guide walks through the real sections
    page.click("[data-act=mission-start]")
    page.wait_for_selector("#missionBar.on")
    check(has(page, "#missionBar", "Step 1"), f"[{tag}] mission step 1 shown")
    for _ in range(7):
        page.click("[data-act=mission-done]")
        page.wait_for_timeout(120)
    check(has(page, "#missionBar", "Mission complete"), f"[{tag}] mission completes after 7 steps")
    page.click("#missionBar [data-act=mission-exit]")
    check(has(page, "#command", "Mission complete for today"), f"[{tag}] command center shows completion")

    # Phase 12 — Teach Me through all steps
    page.click("#syllabus details.subj >> nth=0")
    page.click("#syllabus [data-act=teach] >> nth=1")
    for i in range(6):
        page.click("#teach button.btn.sm:has-text('Next')")
    page.click("#teach [data-act=studied]")
    check(has(page, "#teach", "Next revision"), f"[{tag}] Teach Me ends with a scheduled revision")

    # Phase 5 — Prelims Practice
    page.click("#prelims [data-act=prelims-mode][data-mode=mixed]")
    page.wait_for_selector("#prelims .opt")
    n = page.locator("#prelims .q").count()
    for i in range(n):
        page.locator("#prelims .q").nth(i).locator(".opt").first.click()
    check(page.locator("#prelims .expl").count() == n, f"[{tag}] answer review shown for all {n} questions")
    check(has(page, "#prelims", "BIGGEST WEAKNESS"), f"[{tag}] prelims analytics visible")
    shot(page, f"{tag}-04-prelims")

    # Phase 7 — PYQ (offline in CI: must show the official-archive fallback, never a dead end)
    page.click("#pyq [data-act=pyq-paper] >> nth=0")
    page.wait_for_timeout(600)
    txt = page.inner_text("#pyq").lower()
    check("upsc.gov.in" in txt or "open pdf" in txt, f"[{tag}] PYQ shows papers or the official archive link")
    page.click("#pyq [data-act=add-rev]")

    # Phase 8 — Mains lab with weakness + rewrite
    page.click("#pyq [data-act=mains-topic]")
    page.fill("#mainsText", "This is a short answer about the issue that does not cover much ground but has more than thirty words so that it can be evaluated by the rubric in the mains answer lab today for testing purposes only.")
    page.click("[data-act=mains-submit]")
    page.wait_for_selector("#mains .weak")
    page.click("[data-act=mains-rewrite]")
    check(page.locator("#mainsText").input_value() != "", f"[{tag}] rewrite keeps the draft")
    shot(page, f"{tag}-05-mains")

    # Phase 9 — revision buckets and rating
    rev = page.inner_text("#revision").lower()
    check("revision due today" in rev and "high priority" in rev and "completed" in rev, f"[{tag}] revision buckets present")

    # Phase 10 — CSAT
    page.click("#csat [data-act=csat-cat][data-cat=numeracy]")
    page.locator("#csat .q").first.locator(".opt").first.click()
    check(has(page, "#csat", "CSAT ACCURACY"), f"[{tag}] CSAT stats")

    # Phase 6 — current affairs renders a result list or the fallback message
    page.locator("#ca").scroll_into_view_if_needed()
    page.wait_for_timeout(800)
    check(page.locator("#caList").inner_text().strip() != "", f"[{tag}] current affairs shows items or a clear fallback")

    # Phase 11 — readiness
    r = page.inner_text("#readiness").lower()
    check("strongest area" in r and "next priority" in r, f"[{tag}] readiness dashboard")
    page.click("[data-act=ready-go]")

    # Hindi toggle and persistence
    page.click("#langBtn")
    page.wait_for_timeout(200)
    check(page.evaluate("document.documentElement.lang") == "hi", f"[{tag}] Hindi toggle")
    check(has(page, "#command", "आज का आपका मिशन"), f"[{tag}] Hindi command center")
    ok_font = page.evaluate("document.fonts.ready.then(() => document.fonts.check('16px \"Noto Sans Devanagari\"', 'मिशन'))")
    check(ok_font, f"[{tag}] Devanagari font loaded")
    shot(page, f"{tag}-06-hindi")
    page.click("#langBtn")
    state = json.loads(page.evaluate("localStorage.getItem('gyanagi.upsc.v1')"))
    check(state["profile"]["optional"] == "Sociology" and len(state["attempts"]) >= n, f"[{tag}] state persisted in localStorage")
    page.reload()
    page.wait_for_selector("#command .steps")
    check(has(page, "#command", "Mission complete for today"), f"[{tag}] state survives reload")

    # every visible button does something (has a handler or submits a form)
    dead = page.evaluate("""() => [...document.querySelectorAll('button')].filter(b => b.offsetParent && !b.dataset.act && b.type !== 'submit' && !b.onclick && !b.closest('summary')).map(b => b.textContent.trim())""")
    check(not dead, f"[{tag}] no dead buttons {dead}")
    sw, cw = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
    check(sw <= cw + 1, f"[{tag}] no horizontal overflow ({sw} <= {cw})")
    b.close()


with sync_playwright() as p:
    run(p, 1280, 860, "desktop")
    run(p, 390, 844, "mobile")
if errors:
    print("\n".join(errors))
    sys.exit(1)
print("browser check passed")
