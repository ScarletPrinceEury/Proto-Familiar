# Tomes

Tomes are persistent knowledge bases that automatically inject context into every LLM prompt when relevant keywords appear in the conversation. Proto-Familiar implements a full SillyTavern-compatible World Info engine across an unlimited number of independent Tome files.

Tomes are stored as individual JSON files inside the `tomes/` directory (auto-created, git-ignored). Each Tome is a standalone file — `tomes/<uuid>.json` — and can be independently enabled or disabled. Manage them via **☰ → Tomes → Manage Tomes** in the sidebar.

---

## Multiple Tomes

Unlike a single monolithic world-info file, Proto-Familiar stores each Tome separately so they can be:

- **Toggled individually** — enable or disable a whole Tome without deleting its entries
- **Named and described** — give each Tome a clear purpose (e.g. *"World Lore"*, *"Character Notes"*, *"Session Memories"*)
- **Stacked freely** — all enabled Tomes are scanned together; entries from every active Tome compete and cooperate as a single unified pool

The activation engine aggregates entries from every enabled Tome before applying keyword scanning, group exclusion, and injection ordering. Order between Tomes is determined by each entry's `insertion_order` field, not Tome order.

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

Timed effect state is tracked in memory per page-load (not persisted). The counters reset when the page reloads.

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

Groups work across Tomes — entries from different Tomes sharing a group name are treated as competitors.

---

## Probability

Set **Probability (0–100)** to randomly skip an entry even when its keywords match. The default is 100 (always activates when triggered). Use values below 100 to add variation to world-building entries.

---

## Tome File Format

Each Tome is stored as a JSON file at `tomes/<id>.json`:

```json
{
  "id":          "550e8400-e29b-41d4-a716-446655440000",
  "name":        "World Lore",
  "description": "Geographical and cultural facts about the setting.",
  "enabled":     true,
  "entries": {
    "<uid>": { ... }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | UUID — matches the filename |
| `name` | string | Human-readable Tome name |
| `description` | string | Optional description shown in the Tomes Manager |
| `enabled` | boolean | Whether this Tome participates in activation |
| `entries` | object | Map of `uid → entry` |

---

## Entry Schema

| Field | Type | Description |
|---|---|---|
| `uid` | string | Auto-generated unique identifier |
| `comment` | string | Human-readable label (shown in the entry list) |
| `content` | string | The text injected into the prompt when the entry activates |
| `keys` | string[] | Primary keyword list |
| `keysecondary` | string[] | Secondary keys for selective logic |
| `selectiveLogic` | number | `0`=AND_ANY, `1`=NOT_ANY, `2`=AND_ALL, `3`=NOT_ALL |
| `selective` | boolean | Whether secondary keys are enabled |
| `position` | number | `0`=before_char, `1`=after_char, `2`=sys_top, `3`=sys_bottom, `4`=at_depth |
| `depth` | number | Chat depth for `at_depth` injection |
| `role` | number | `0`=system, `1`=user, `2`=assistant (for depth injection) |
| `enabled` | boolean | Whether the entry can activate |
| `scanDepth` | number \| null | Per-entry override for scan depth |
| `caseSensitive` | boolean \| null | Per-entry override for case sensitivity |
| `matchWholeWords` | boolean \| null | Per-entry override for whole-word matching |
| `sticky` | number \| null | Sticky counter (messages to stay active after last match) |
| `cooldown` | number \| null | Cooldown counter (messages suppressed after sticky expires) |
| `probability` | number | 0–100, chance of activation when keywords match |
| `group` | string | Group name for group exclusion |
| `groupWeight` | number \| null | Priority within a group |
| `insertion_order` | number | Sort order when multiple entries inject at the same position (lower = earlier) |
| `constant` | boolean | If true, always injects regardless of keyword matching |
| `preventRecursion` | boolean | Excludes this entry's content from recursive scan passes |
| `delayUntilRecursion` | boolean | Only activates on recursive passes, not the initial scan |
| `excludeRecursion` | boolean | Not checked during recursive passes at all |
