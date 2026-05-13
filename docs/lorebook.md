# Lorebook

The Lorebook is a persistent knowledge base that automatically injects context into every LLM prompt when relevant keywords appear in the conversation. Proto-Familiar implements a full SillyTavern-compatible World Info engine.

The lorebook is stored in `lorebook.json` in the project root (auto-created on first save, git-ignored). Manage it via **☰ → Lorebook → View entries** in the sidebar.

---

## Activation

An entry activates when its **primary keys** match somewhere in the **scan corpus** — the most recent N user and assistant messages plus the new user input, where N is the **Keyword scan depth** setting.

### Key Syntax

- **Plain text** — matched as a case-insensitive substring (by default).
- **`/pattern/flags`** — matched as a JavaScript regular expression (e.g. `/\bcat(s)?\b/i`).

### Global Settings

| Setting | Default | Description |
|---|---|---|
| Keyword scan depth | 4 | Number of recent messages included in the scan corpus |
| Case sensitive | Off | Match keys case-sensitively |
| Whole word | Off | Only match at word boundaries |
| Enable recursion | Off | Run additional scan passes over activated content |
| Max recursion steps | 3 | Maximum number of recursive passes |

Per-entry overrides for scan depth, case sensitivity, and whole-word can be set in the entry editor; leave blank to inherit the global default.

---

## Injection Positions

| Position | Label | Where the entry content is inserted |
|---|---|---|
| `sys_top` | ⬆ Top of system message | Before everything else in the system message |
| `before_char` | ↑ Before character profile | Between the system prompt text and `[Character Profile]` |
| `after_char` | ↓ After character profile | Between `[Character Profile]` and `[User Profile]` |
| `sys_bottom` | ⬇ Bottom of system message | After all other system message content |
| `at_depth` | @ At chat depth | Spliced directly into the conversation history at `depth` messages from the end, as a `system`, `user`, or `assistant` message |

When multiple entries activate at the same position, they are concatenated in insertion-order with `---` separators.

---

## Selective Logic

Enable **Require secondary key match** on an entry to add a second gating condition:

| Mode | Behaviour |
|---|---|
| AND ANY | Primary match + **at least one** secondary key matches |
| NOT ANY | Primary match + **no** secondary key matches |
| AND ALL | Primary match + **all** secondary keys match |
| NOT ALL | Primary match + **at least one** secondary key does not match |

---

## Timed Effects

| Effect | Description |
|---|---|
| **Sticky N** | Once activated, the entry continues injecting for the next N messages even if its keywords are no longer present in the scan corpus. |
| **Cooldown N** | After a sticky period ends (or after a normal one-shot activation), the entry is suppressed for N messages before it can trigger again. |

Timed effect state is tracked per session. The counters reset when the page reloads.

---

## Recursion

When **Enable recursion** is on, activated entries' content is itself added to the scan corpus and re-scanned for keyword matches, up to **Max recursion steps** additional passes.

Per-entry recursion flags:

| Flag | Effect |
|---|---|
| Prevent recursion | This entry's content is not added to the recursive scan corpus |
| Delay until recursion | This entry only activates during a recursive pass, not the initial scan |
| Exclude from recursion | This entry is not checked during recursive passes |

---

## Group Exclusion

Set the same **Group name** on multiple entries to make them compete: only the one entry with the highest **Weight** (ties broken by lowest insertion order) activates when any member of the group is triggered. Use this for mutually exclusive content like location descriptions, relationship states, or character moods.

---

## Probability

Set **Probability (0–100)** to randomly skip an entry even when its keywords match. The default is 100 (always activates when triggered). Use values below 100 to add variation to world-building entries.

---

## Entry Schema

Each lorebook entry has the following fields:

| Field | Type | Description |
|---|---|---|
| `uid` | string | Auto-generated unique identifier |
| `comment` | string | Human-readable label (shown in the entry list) |
| `content` | string | The text injected into the prompt when the entry activates |
| `keys` | string[] | Primary keyword list |
| `secondaryKeys` | string[] | Secondary keys for selective logic |
| `selectiveLogic` | string | `"and_any"`, `"not_any"`, `"and_all"`, `"not_all"` |
| `selective` | boolean | Whether secondary keys are enabled |
| `position` | string | Injection position (see table above) |
| `depth` | number | Chat depth for `at_depth` injection |
| `depthRole` | string | `"system"`, `"user"`, or `"assistant"` for depth injection |
| `enabled` | boolean | Whether the entry can activate |
| `scanDepth` | number \| null | Per-entry override for scan depth |
| `caseSensitive` | boolean \| null | Per-entry override for case sensitivity |
| `matchWholeWords` | boolean \| null | Per-entry override for whole-word matching |
| `sticky` | number | Sticky counter (messages to stay active after last match) |
| `cooldown` | number | Cooldown counter (messages suppressed after sticky expires) |
| `probability` | number | 0–100, chance of activation when keywords match |
| `group` | string | Group name for group exclusion |
| `weight` | number | Priority within a group |
| `preventRecursion` | boolean | Exclude this entry's content from recursive scans |
| `delayUntilRecursion` | boolean | Only activate during recursive passes |
| `excludeFromRecursion` | boolean | Do not check this entry during recursive passes |

---

## Managing Entries

Open **☰ → Lorebook → View entries**. From there:
- **+ New** — creates a blank entry and opens its editor.
- **Edit** — opens the full editor for any existing entry.
- Toggle the **enabled** checkbox directly in the list to quickly disable/enable an entry without opening the editor.

Entries created by the [Topic auto-summary](topics.md) flow start with `before_char` injection position and the keywords chosen at summary time. They are indistinguishable from hand-crafted entries and can be edited, disabled, or deleted freely.

Entries created by [Session memorization](sessions.md#session-memorization) work the same way.
