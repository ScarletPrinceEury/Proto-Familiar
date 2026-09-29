# Optimization & clarity audit (2026-09)

A different lens from the pass-2 re-audit. Not "is it broken?" but "could it be
**better**?" — without sacrificing functionality. Four questions:

1. **Optimizable / rewritable** — where could code be more resource-friendly,
   robust, fast, elegant, or minimal? (Real wins only — not churn for its own sake,
   and never at the cost of the graceful-degradation / safety guarantees.)
2. **Comment concision** — comments that could be cut or written shorter/tighter
   without becoming incomprehensible. (The codebase leans *very* commented; some of
   it is load-bearing "why", some is restating the "what".)
3. **Doc readability** — `docs/*.md` (and CLAUDE.md-adjacent prose) that could be
   editorialised to read more easily for a layperson: less stiff, less wordy, more
   comprehensible, without losing the technical substance.
4. **Elegance / minimalism** — structural simplifications (a tangled function that
   a clean rewrite shortens, per the "fix the shape" principle).

Severity here = **impact**: **[high]** a real perf/robustness win or a doc a
newcomer would genuinely stumble on · **[med]** a worthwhile tidy · **[low]** nice-to-have.

> Constraints carried from CLAUDE.md: brevity is a *side-effect of clarity*, never
> the goal; a load-bearing "why" comment stays; the first-person Familiar voice and
> the plain-not-lofty register are preserved; no optimization may weaken a
> safety/degradation path. Anything touching a ward-sign-off file is **flagged, not
> changed**.

---

## Findings

_(appended as the audit proceeds)_

### Root Node utilities

- **`own-files.js:106-136` `readOwnFile` — redundant second `fs.stat`.** Line 114
  already stats the file (`st.size` is the full size); line 132 re-stats only to
  compute `truncated`. Reuse the first: `truncated = st.size > buf.length`, drop
  the second stat + its try/catch. One fewer syscall per file read; behaviour
  identical. **[low]**
- **Comment-density note (not yet a fix):** several root utilities carry a
  15-20-line header comment above a 4-8-line function (`macros.js`,
  `phylactery-result.js`). These are genuine "why" (fallback rationale, the
  silent-failure class) and read well, so they *stay* — noting only that the
  house style runs comment-heavy, which the per-file passes below weigh case by
  case rather than trimming reflexively.

### Elegance / minimalism

- **A `readJsonFile(path, fallback)` helper** could absorb the repeated
  `try { JSON.parse(readFileSync(file)) } catch { return <fallback> }` shape for
  per-module JSON *state* files (not settings — those go to `settings-store`, see
  the pass-2 headline). Sites: `voice-clips.js:39`, `call-engine.js:676`,
  `browser/page-watch.js:41`, `weather-mirror.js:66`, `wait-streak.js:97`,
  `pondering/ponder-web-budget.js:31` — ~6 near-identical readers. **[low-med]** —
  weigh against premature abstraction: the fallbacks differ (`{}`, `null`, a typed
  default), so a shared helper needs a `fallback` param; only worth it if it reads
  cleaner than the 2-line inline. Judgement call, flagged not mandated.

---

## Coverage log

- ☐ Node hot paths (enrich, chat turn, tool loop, discord turn, memorization)
- ☐ Python (memory.py, consolidate.py, schedule.py, tracker.py, graph.py)
- ☐ Comment-density sweep (the big files)
- ☐ docs/*.md readability pass
