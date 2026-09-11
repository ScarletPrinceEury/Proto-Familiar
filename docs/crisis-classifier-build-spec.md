# Crisis classifier — build spec (a raise-only second opinion on distress)

> **Status: DESIGN — awaiting ward review + a validated model. Nothing here is
> wired into the live threat path yet.** This is safety-critical code
> (`crisis-signals.js` / `threat-tracker.js` class): every behavioural change
> needs the ward's sign-off, and this whole pass does too. It is NOT covered by
> any "keep working / auto-merge" grant.

## 0. Why

The current detector (`crisis-signals.js`) is a hand-written tiered regex
lexicon. The ward's own note: it was **created fairly blindly** — no evidence
base for which phrases matter or how much. It is careful and auditable, but its
weakness is **recall**: a fixed phrase list misses the many ways a person voices
ideation. The `vibhorag101/suicide_prediction_dataset_phr` dataset (~230k Reddit
posts, binary `suicide`/`non-suicide`) gives us, for the first time, (a) a way to
**measure** recall/precision instead of guessing, and (b) a source to learn a
broader signal from.

The ward chose to add an **ML classifier as a second signal** (not a
replacement). This spec is that, built so it can only ever *help* the detector
catch more, never cause it to catch less.

## 1. Invariants (non-negotiable — these are the safety spine)

1. **Additive, never a replacement.** The regex scorer stays exactly as it is and
   keeps running. The classifier is a separate signal combined with it.
2. **Raise-only.** The classifier can only push threat UP. A "not suicide"
   verdict contributes **0** — it can NEVER lower the regex-derived level or damp
   a regex hit. (Mirrors the vision-threat raise-only rule.)
3. **The classifier alone caps at HIGH, never SEVERE.** SEVERE is what drives
   auto-escalation to trusted contacts (`cerebellum.js`). A black-box score must
   not unilaterally contact a human. The classifier can raise threat up to HIGH,
   which hands the moment to the silence-triage LLM to judge *with full context*
   — improving the recall of what reaches triage, not bypassing it. SEVERE stays
   gated on the explicit regex signals + the triage/LLM judgment.
4. **Never remove a regex signal without evidence.** A blindly-built list can be
   re-weighted or added to, but a currently-firing severe/high phrase is removed
   only if the held-out data shows it is a proven false-positive — never blind.
5. **Recall must be shown to go UP, not down, before it ships.** Validation on a
   held-out split is a gate, not a nicety (§7).
6. **Graceful degradation is absolute.** A missing, unparseable, or version-
   mismatched model artifact → the classifier contributes 0 and the regex path is
   completely unaffected. The classifier can never break or slow the chat path
   into failure; a thrown inference is caught and treated as "no signal".
7. **Off-switch in the same commit as the wiring.** `crisisClassifierEnabled`
   (setting, synced) + `PROTO_FAMILIAR_CRISIS_CLASSIFIER_DISABLED=1`. Also stands
   down whenever `PROTO_FAMILIAR_THREAT_DISABLED=1` (it's part of threat scoring).

## 2. Architecture

```
  (offline, where the dataset is reachable)         (runtime, in the app)
  scripts/train-crisis-classifier.py                src/safety/crisis-classifier.js
    dataset → clean → tokenize → TF-IDF → logreg       load artifact (once)
    → evaluate (recall/precision + guards)             scoreMessageML(text) → { p, contribution }
    → emit  models/crisis-classifier.json                     │
                         │                                    ▼
                         └────────── artifact ──────►  combined at the ONE seam with
                                  (vocab + weights)     scoreMessage()'s regex level
                                                        (raise-only, capped at HIGH)
```

- **Model: TF-IDF (word 1–2 grams, capped vocab) + logistic regression.** The
  only sane choice that runs in-process with no native dependency and no network:
  inference is a tokenize → sparse dot-product → sigmoid, pure JS. It is also
  **auditable** — the top-weighted tokens can be listed for ward review, unlike a
  transformer. (A transformer/onnx path is explicitly out of scope: heavy dep,
  latency, and a fully opaque score feeding a safety tier.)
- **Trainer is Python/sklearn** (an offline dev tool, not a runtime dep), because
  that is the correct tool for TF-IDF+logreg and the artifact it emits is
  language-neutral. The **runtime never trains and never runs Python** — it only
  reads the JSON artifact. (Exact-values rule: the numbers are machine-generated;
  the JS only repeats them.)

## 3. Artifact format (`models/crisis-classifier.json`, git-ignored — it's large + machine-built)

```json
{
  "version": 1,
  "kind": "tfidf-logreg",
  "tokenizer": { "lowercase": true, "ngram": [1, 2], "token_re": "<the exact regex, mirrored in JS>" },
  "vocab": { "term": <index>, ... },
  "idf":   [<float per vocab index>],
  "coef":  [<float per vocab index>],
  "intercept": <float>,
  "calibration": { "threshold": <float>, "note": "p below this contributes 0" },
  "meta": { "trainedAt": "...", "rows": N, "metrics": { ... }, "topTokens": [["term", w], ...] }
}
```

The artifact is **git-ignored** (megabytes, machine-built, per-install), the same
posture as the media store and the pin overlay. A separate tiny committed file
(or the build spec) records the *expected* `version` so a stale artifact is
detected and ignored rather than trusted.

## 4. Tokenizer parity (the exact-values seam)

The JS inference tokenizer MUST produce the same tokens as the Python trainer, or
every score is quietly wrong. So the tokenizer is defined once, minimally
(lowercase, a single documented `token_re`, 1–2 grams), and the **regex string is
carried in the artifact** and applied verbatim on both sides. A parity test
(§10) pins a handful of strings to their expected token lists on the JS side, and
the trainer emits those same fixtures so drift is caught.

## 5. Combination & tier ceiling (the safety seam — `crisis-signals` + classifier)

At the one place a message is scored for threat, the regex `level` and the
classifier are combined:

- `p = sigmoid(coef · tfidf(text) + intercept)`.
- `contribution = 0` when `p < threshold` (no signal — never negative).
- Above threshold, `contribution` scales with `p` up to a cap `CLASSIFIER_MAX`
  chosen so the classifier ALONE reaches at most the HIGH tier's threshold in
  `threat-tracker` — never SEVERE.
- `finalLevel = max(regexLevel, regexLevel + contribution)` — i.e. it only ever
  adds. (Written as a max so it is *obviously* raise-only to a reviewer.)
- Fired-signal audit gains a synthetic entry `{ id:'ml_classifier', tier, p,
  contribution }` so the classifier's say is as auditable as every regex signal
  (the detector's "every trigger is logged" promise extends to it).

The `threshold` and `CLASSIFIER_MAX` are **tuned on held-out data and reviewed by
the ward**, not guessed — they trade recall against false check-ins, and false
check-ins are cheap while the SEVERE ceiling keeps false *escalations* off the
table.

## 6. Distribution mismatch (Reddit posts → chat) — handled, not ignored

The dataset is long-form Reddit posts; the Familiar sees short chat turns. So:
- The regex remains the always-on floor — a short explicit "I want to die" is
  caught by regex regardless of how the classifier generalises.
- Validation includes a **short-message / chat-like eval** (§7), not just the
  Reddit held-out split, so we see transfer before trusting it.
- The threshold is tuned conservatively for the chat register.

## 7. Training + validation (the gate)

`scripts/train-crisis-classifier.py`:
1. Load the dataset (column names configurable / auto-detected — not assumed).
2. Clean + dedup; stratified train/test split.
3. TF-IDF + logreg; emit the artifact.
4. **Report, and hold as gates:**
   - recall / precision / PR-AUC on the held-out split;
   - a **regression guard**: every current regex `example` string (imported from
     `crisis-signals.js`) must still net at least its current tier under the
     combined detector — proof recall did not drop;
   - a **short-message eval**: a curated set of short ideation phrasings + benign
     short chat, to measure chat transfer and false-positive rate;
   - the top-weighted tokens, for the ward to eyeball for anything absurd.
- Data access: the cloud session can READ the Hub via the MCP connector (schema,
  card, ~100-row previews — enough to design against) but raw bulk egress to
  huggingface.co stays firewalled (a 43 MB parquet can't be pulled or streamed as
  tool output). So **training runs on the ward's machine**, where the dataset is
  reachable, via a one-command script (`uv run --with datasets --with
  scikit-learn … scripts/train-crisis-classifier.py`). The script downloads the
  dataset (public, MIT), trains, evaluates, and writes `models/crisis-classifier.json`
  + prints the metrics for gate 2. The session builds and smoke-tests that script
  against a synthetic local CSV (no HF needed); the ward runs it for real.
- Cleaning skew (measured, not ignored): the dataset text is heavily
  NLP-preprocessed (stopword-stripped, contractions expanded, likely lemmatised).
  We do NOT try to replay that pipeline in JS — instead the trainer and the JS
  inference share ONE light, fully-replicable normalization (lowercase, strip
  non-letter, collapse whitespace + 3+ repeats), and the residual (stopwords /
  unlemmatised forms in live chat) simply falls out of vocabulary and is ignored
  by TF-IDF. The high-weight content tokens (die, suicide, suffering, burden,
  worthless, end…) transfer; the short-message eval measures how much.

## 8. Ward sign-off gates (all three required before it is live)

1. **Design** — approve this spec.
2. **Model** — review the trained artifact's metrics + top tokens; confirm recall
   is up and nothing absurd is weighted high.
3. **Wiring** — approve the live combination + the chosen `threshold`/`cap`. Only
   then does the seam in §5 get wired and the off-switch ship with it.

Not auto-merged at any stage.

## 9. Testing plan

- **Inference unit tests** (JS): a tiny synthetic fixture artifact → known
  tokens, known score; graceful-degradation (missing/broken/version-mismatch
  artifact → contribution 0, never throws); off-switch → 0.
- **Combination tests**: raise-only (a low-`p` message never lowers a regex
  level; a negative would be clamped); the classifier alone never exceeds the
  HIGH ceiling; a regex SEVERE + classifier stays SEVERE (not doubled past cap).
- **Tokenizer parity test**: fixed strings → expected tokens, matching the
  trainer's emitted fixtures.
- **Trainer smoke test**: run the trainer on a tiny synthetic CSV (no HF needed)
  and assert it emits a well-formed artifact the JS loader accepts.
- **Pipeline test**: a full threat-scoring call through the combined path with a
  stubbed artifact.

## 10. Out of scope

- Transformer / neural models; any GPU or onnx runtime dependency.
- The classifier ever lowering threat, damping a regex hit, or reaching SEVERE on
  its own.
- Shipping a model the ward has not seen the metrics for.
