# Marinara Engine — Lorebook Trigger & Hook Architecture

**Research Date:** April 29, 2026  
**Repository:** https://github.com/Pasta-Devs/Marinara-Engine  
**Version:** Main branch

---

## Table of Contents

1. [Overview](#overview)
2. [Lorebook Entry Triggering System](#lorebook-entry-triggering-system)
3. [Hook Architecture for Message Processing](#hook-architecture-for-message-processing)
4. [Implementation Details](#implementation-details)
5. [Advanced Features](#advanced-features)
6. [Integration with Generation Pipeline](#integration-with-generation-pipeline)

---

## Overview

Marinara Engine implements a sophisticated lorebook system that dynamically injects contextual information into AI prompts based on keyword triggers, semantic similarity, and game state conditions. The system supports recursive scanning, token budgeting, and multiple injection strategies.

**Core Architecture:**
- **Keyword Scanner** — Detects which entries should activate based on chat content
- **Prompt Injector** — Injects activated entries at appropriate positions in the prompt
- **Hook System** — Integrates lorebook content into the generation pipeline
- **Storage Layer** — Manages persistence and retrieval of lorebook data

---

## Lorebook Entry Triggering System

### 1.1 Entry Data Structure

**File:** `packages/shared/src/types/lorebook.ts` (Lines 46-116)

```typescript
export interface LorebookEntry {
  id: string;
  lorebookId: string;
  name: string;
  content: string;              // Injected content
  description: string;          // Used by knowledge-router agent
  
  // Trigger keywords
  keys: string[];               // Primary keywords
  secondaryKeys: string[];      // Optional keywords
  
  // Activation settings
  enabled: boolean;
  constant: boolean;            // Always active
  selective: boolean;           // Requires secondary keys
  selectiveLogic: SelectiveLogic;  // "and" | "or" | "not"
  probability: number | null;   // Activation probability (0-100)
  scanDepth: number | null;     // Messages to scan (null = all)
  matchWholeWords: boolean;
  caseSensitive: boolean;
  useRegex: boolean;
  
  // Injection settings
  position: number;             // 0=before char, 1=after char, 2=depth
  depth: number;                // Insertion depth (if position=2)
  order: number;                // Priority (lower = earlier)
  role: LorebookRole;           // "system" | "user" | "assistant"
  
  // Timing controls
  sticky: number | null;        // Stay active for N messages
  cooldown: number | null;      // Wait N messages between activations
  delay: number | null;         // Delay N messages before first activation
  ephemeral: number | null;     // Activations remaining
  
  // Grouping
  group: string;
  groupWeight: number | null;   // Weight within group
  
  // Advanced
  preventRecursion: boolean;
  tag: string;
  activationConditions: ActivationCondition[];
  schedule: LorebookSchedule | null;
  embedding: number[] | null;   // For semantic matching
}
```

### 1.2 Scanning Algorithm

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 291-401)

The main scanning function `scanForActivatedEntries()` processes entries through multiple stages:

#### Stage 1: Initial Filtering
```typescript
export function scanForActivatedEntries(
  messages: ScanMessage[],
  entries: LorebookEntry[],
  options: ScanOptions = {},
): ActivatedEntry[] {
  const {
    scanDepth = 0,
    gameState = null,
    timingStates = new Map(),
    currentMessageIndex = messages.length,
    chatEmbedding = null,
    semanticThreshold = 0.3,
  } = options;

  // Build text to scan from recent messages
  const messagesToScan = scanDepth > 0 ? messages.slice(-scanDepth) : messages;
  const combinedText = messagesToScan.map((m) => m.content).join("\n");
```

**Line 291:** Function accepts messages, entries, and scanning options  
**Line 300:** Scan depth determines how many recent messages to check  
**Line 301:** Combines message content into single searchable string

#### Stage 2: Entry Processing Loop

```typescript
for (const entry of entries) {
  // Skip disabled entries
  if (!entry.enabled) continue;

  // Constant entries are always activated
  if (entry.constant) {
    activated.push({
      entry,
      matchedKeys: ["[constant]"],
      injectionOrder: entry.order,
    });
    activatedIds.add(entry.id);
    continue;
  }

  // Probability check
  if (entry.probability !== null && entry.probability < 100) {
    if (Math.random() * 100 > entry.probability) continue;
  }

  // Check timing (sticky/cooldown/delay)
  if (!checkTiming(entry, timingStates.get(entry.id), currentMessageIndex)) {
    continue;
  }

  // Check activation conditions
  if (!evaluateConditions(entry.activationConditions, gameState)) {
    continue;
  }

  // Check schedule
  if (!evaluateSchedule(entry.schedule, gameState)) {
    continue;
  }
```

**Line 317:** Constant entries bypass all checks  
**Line 329:** Probability check for random activation  
**Line 334:** Timing validation for sticky/cooldown/delay  
**Line 338:** Game state conditional checks  
**Line 342:** Schedule-based activation checks

#### Stage 3: Keyword Matching

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 344-364)

```typescript
// Per-entry scan depth override
const entryScanText =
  entry.scanDepth !== null && entry.scanDepth > 0
    ? messages
        .slice(-entry.scanDepth)
        .map((m) => m.content)
        .join("\n")
    : combinedText;

const matchOptions = {
  useRegex: entry.useRegex,
  matchWholeWords: entry.matchWholeWords,
  caseSensitive: entry.caseSensitive,
};

// Test primary keys
const { matched, matchedKeys } = testPrimaryKeys(entry.keys, entryScanText, matchOptions);
if (!matched) continue;

// Test secondary keys (selective mode)
if (entry.selective && entry.secondaryKeys.length > 0) {
  if (!testSecondaryKeys(entry.secondaryKeys, entryScanText, entry.selectiveLogic, matchOptions)) {
    continue;
  }
}

activated.push({
  entry,
  matchedKeys,
  injectionOrder: entry.order,
});
activatedIds.add(entry.id);
```

**Line 346:** Per-entry scan depth can override lorebook default  
**Line 360:** Primary keys must match to proceed  
**Line 363:** Secondary keys checked if `selective` is enabled

#### Stage 4: Keyword Testing Logic

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 64-96)

```typescript
function testKeyword(
  keyword: string,
  text: string,
  options: { useRegex: boolean; matchWholeWords: boolean; caseSensitive: boolean },
): boolean {
  const flags = options.caseSensitive ? "" : "i";

  if (options.useRegex) {
    try {
      const pattern = new RegExp(keyword, flags);
      return pattern.test(text);
    } catch {
      return false;
    }
  }

  // Literal matching
  const searchText = options.caseSensitive ? text : text.toLowerCase();
  const searchKey = options.caseSensitive ? keyword : keyword.toLowerCase();

  if (options.matchWholeWords) {
    const pattern = new RegExp(`\\b${searchKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, flags);
    return pattern.test(searchText);
  }

  return searchText.includes(searchKey);
}
```

**Line 64:** Single keyword test with configurable options  
**Line 68:** Regex mode with try/catch for invalid patterns  
**Line 80:** Whole word matching escapes special characters  
**Line 84:** Simple substring matching as fallback

#### Stage 5: Secondary Key Logic

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 115-139)

```typescript
function testSecondaryKeys(
  secondaryKeys: string[],
  text: string,
  logic: SelectiveLogic,
  options: { useRegex: boolean; matchWholeWords: boolean; caseSensitive: boolean },
): boolean {
  if (secondaryKeys.length === 0) return true;

  const results = secondaryKeys.map((key) => testKeyword(key, text, options));

  switch (logic) {
    case "and":
      return results.every(Boolean);
    case "or":
      return results.some(Boolean);
    case "not":
      return !results.some(Boolean);
    default:
      return true;
  }
}
```

**Line 124:** Test all secondary keys  
**Line 127:** AND logic — all must match  
**Line 129:** OR logic — at least one must match  
**Line 131:** NOT logic — none can match

#### Stage 6: Semantic Fallback

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 364-386)

```typescript
// Semantic fallback: check entries with embeddings that weren't keyword-matched
if (chatEmbedding && chatEmbedding.length > 0) {
  for (const entry of entries) {
    if (!entry.enabled || entry.constant || activatedIds.has(entry.id)) continue;
    if (!entry.embedding || entry.embedding.length === 0) continue;

    const similarity = cosineSimilarity(chatEmbedding, entry.embedding);
    if (similarity >= semanticThreshold) {
      activated.push({
        entry,
        matchedKeys: [`[semantic:${similarity.toFixed(3)}]`],
        injectionOrder: entry.order,
      });
      activatedIds.add(entry.id);
    }
  }
}
```

**Line 369:** Cosine similarity matching for entries with embeddings  
**Line 371:** Default threshold is 0.3  
**Line 374:** Semantic matches labeled with similarity score

#### Stage 7: Group Selection

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 233-265)

```typescript
function applyGroupSelection(entries: ActivatedEntry[]): ActivatedEntry[] {
  const grouped = new Map<string, ActivatedEntry[]>();
  const ungrouped: ActivatedEntry[] = [];

  for (const entry of entries) {
    const group = entry.entry.group;
    if (group) {
      const list = grouped.get(group) ?? [];
      list.push(entry);
      grouped.set(group, list);
    } else {
      ungrouped.push(entry);
    }
  }

  const result: ActivatedEntry[] = [...ungrouped];

  for (const [, groupEntries] of grouped) {
    // Sort by weight (higher = more likely), then by order
    groupEntries.sort((a, b) => {
      const wA = a.entry.groupWeight ?? 100;
      const wB = b.entry.groupWeight ?? 100;
      if (wA !== wB) return wB - wA;
      return a.entry.order - b.entry.order;
    });
    // Pick the highest-weight entry from each group
    const top = groupEntries[0];
    if (top) {
      result.push(top);
    }
  }

  return result;
}
```

**Line 242:** Groups entries by `group` field  
**Line 257:** Sorts by weight (higher = priority)  
**Line 262:** Selects only top entry per group

### 1.3 Activation Conditions

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 144-167)

```typescript
export function evaluateConditions(conditions: ActivationCondition[], gameState: GameStateForScanning | null): boolean {
  if (conditions.length === 0) return true;
  if (!gameState) return true; // No game state = conditions pass (permissive)

  for (const condition of conditions) {
    const fieldValue = String(gameState[condition.field] ?? "");

    switch (condition.operator) {
      case "equals":
        if (fieldValue.toLowerCase() !== condition.value.toLowerCase()) return false;
        break;
      case "not_equals":
        if (fieldValue.toLowerCase() === condition.value.toLowerCase()) return false;
        break;
      case "contains":
        if (!fieldValue.toLowerCase().includes(condition.value.toLowerCase())) return false;
        break;
      case "not_contains":
        if (fieldValue.toLowerCase().includes(condition.value.toLowerCase())) return false;
        break;
      case "gt":
        if (parseFloat(fieldValue) <= parseFloat(condition.value)) return false;
        break;
      case "lt":
        if (parseFloat(fieldValue) < parseFloat(condition.value)) return false;
        break;
    }
  }

  return true;
}
```

**Line 146:** Permissive by default — passes if no game state  
**Line 151:** Supports equals/not_equals/contains/not_contains/gt/lt operators  
**Line 153:** String comparisons are case-insensitive

### 1.4 Schedule-Based Activation

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 179-200)

```typescript
function evaluateSchedule(schedule: LorebookSchedule | null, gameState: GameStateForScanning | null): boolean {
  if (!schedule) return true;
  if (!gameState) return true;

  // Check active times
  if (schedule.activeTimes.length > 0 && gameState.time) {
    const currentTime = String(gameState.time).toLowerCase();
    const matches = schedule.activeTimes.some((t) => currentTime.includes(t.toLowerCase()));
    if (!matches) return false;
  }

  // Check active dates
  if (schedule.activeDates.length > 0 && gameState.date) {
    const currentDate = String(gameState.date).toLowerCase();
    const matches = schedule.activeDates.some((d) => currentDate.includes(d.toLowerCase()));
    if (!matches) return false;
  }

  // Check active locations
  if (schedule.activeLocations.length > 0 && gameState.location) {
    const currentLoc = String(gameState.location).toLowerCase();
    const matches = schedule.activeLocations.some((l) => currentLoc.includes(l.toLowerCase()));
    if (!matches) return false;
  }

  return true;
}
```

**Line 185:** Time-of-day filtering (e.g., "morning", "evening")  
**Line 191:** Date/season filtering  
**Line 197:** Location-based filtering

---

## Hook Architecture for Message Processing

### 2.1 Generation Pipeline Integration

**File:** `packages/server/src/routes/generate/generate-route.ts` (referenced in dry-run-route.ts)

The lorebook system integrates into the generation pipeline at multiple points:

1. **Pre-Generation Phase** — Lorebooks scan chat history and activate entries
2. **Prompt Assembly Phase** — Activated entries inject into prompt
3. **Agent Hook Phase** — Knowledge retrieval/router agents can override

### 2.2 Hook Points

**File:** `packages/server/src/services/lorebook/index.ts` (Lines 98-257)

```typescript
export async function processLorebooks(
  db: DB,
  messages: ScanMessage[],
  gameState?: GameStateForScanning | null,
  options?: {
    chatId?: string;
    characterIds?: string[];
    personaId?: string | null;
    activeLorebookIds?: string[];
    tokenBudget?: number;
    enableRecursive?: boolean;
    chatEmbedding?: number[] | null;
    semanticThreshold?: number;
    entryStateOverrides?: Record<string, { ephemeral?: number | null; enabled?: boolean }>;
  },
): Promise<LorebookScanResult> {
  const storage = createLorebooksStorage(db);

  // Build filters for scoped lorebook selection
  const filters = options
    ? {
        chatId: options.chatId,
        characterIds: options.characterIds,
        personaId: options.personaId,
        activeLorebookIds: options.activeLorebookIds,
      }
    : undefined;

  const allLorebooks = (await storage.list()) as unknown as Lorebook[];
  const relevantLorebooks = filterRelevantLorebooks(allLorebooks, filters);
  const relevantLorebooksById = new Map(relevantLorebooks.map((lorebook) => [lorebook.id, lorebook]));

  // Fetch active entries
  let allEntries = applyLorebookDefaults(
    await storage.listActiveEntries(),
    relevantLorebooksById,
  );

  // Filter entries to relevant lorebooks only
  const relevantLorebookIds = new Set(relevantLorebooks.map((b) => b.id));
  allEntries = allEntries.filter((entry) => relevantLorebookIds.has(entry.lorebookId));
```

**Line 98:** Main orchestration function  
**Line 122:** Filters lorebooks by character/persona/chat scope  
**Line 126:** Fetches only active entries from enabled lorebooks

### 2.3 Injection Strategy

**File:** `packages/server/src/services/lorebook/prompt-injector.ts` (Lines 17-72)

```typescript
export function buildWorldInfoBlocks(activatedEntries: ActivatedEntry[]): {
  before: string;
  after: string;
} {
  const beforeParts: string[] = [];
  const afterParts: string[] = [];

  // Sort by order
  const sorted = [...activatedEntries].sort((a, b) => a.entry.order - b.entry.order);

  for (const { entry } of sorted) {
    if (entry.position <= 0) {
      beforeParts.push(entry.content);
    } else if (entry.position === 1) {
      afterParts.push(entry.content);
    }
    // position >= 2 entries are handled by getDepthInjectedEntries
  }

  return {
    before: beforeParts.join("\n\n"),
    after: afterParts.join("\n\n"),
  };
}

export function getDepthInjectedEntries(activatedEntries: ActivatedEntry[]): Array<{
  content: string;
  role: LorebookRole;
  depth: number;
  order: number;
}> {
  return activatedEntries
    .filter((a) => a.entry.position >= 2 && a.entry.depth > 0)
    .map((a) => ({
      content: a.entry.content,
      role: a.entry.role,
      depth: a.entry.depth,
      order: a.entry.order,
    }))
    .sort((a, b) => {
      if (a.depth === b.depth) return a.order - b.order;
      return a.depth - b.depth;
    });
}
```

**Line 20:** Sorts entries by `order` field (lower = earlier)  
**Line 24:** Position 0 = before character definition  
**Line 26:** Position 1 = after character definition  
**Line 47:** Position 2+ = depth-based injection  
**Line 60:** Depth-based entries sorted by depth then order

### 2.4 Depth Injection Algorithm

**File:** `packages/server/src/services/lorebook/prompt-injector.ts` (Lines 81-110)

```typescript
export function injectAtDepth(
  messages: PromptMessage[],
  depthEntries: Array<{ content: string; role: LorebookRole; depth: number }>,
): PromptMessage[] {
  if (depthEntries.length === 0) return messages;

  const result = [...messages];

  // Group entries by depth
  const byDepth = new Map<number, Array<{ content: string; role: LorebookRole }>>();
  for (const entry of depthEntries) {
    const list = byDepth.get(entry.depth) ?? [];
    list.push({ content: entry.content, role: entry.role });
    byDepth.set(entry.depth, list);
  }

  // Process depths from highest to lowest (to preserve indices)
  const depths = [...byDepth.keys()].sort((a, b) => b - a);

  for (const depth of depths) {
    const entries = byDepth.get(depth) ?? [];
    const insertionIndex = Math.max(0, result.length - depth);

    // Insert all entries for this depth at the same position
    const toInsert: PromptMessage[] = entries.map((e) => ({
      role: e.role,
      content: e.content,
    }));

    result.splice(insertionIndex, 0, ...toInsert);
  }

  return result;
}
```

**Line 97:** Process from highest depth to lowest (preserves indices)  
**Line 101:** Depth 0 = after last message, depth 1 = before last message  
**Line 103:** All entries at same depth inserted together

---

## Implementation Details

### 3.1 Key Files and Line Numbers

| File | Purpose | Key Lines |
|------|---------|-----------|
| `packages/server/src/services/lorebook/keyword-scanner.ts` | Main scanning logic | 291-439 (scanning), 64-96 (keyword testing), 233-265 (grouping) |
| `packages/server/src/services/lorebook/prompt-injector.ts` | Injection logic | 17-46 (world info), 47-72 (depth entries), 81-110 (depth injection), 118-142 (token budget) |
| `packages/server/src/services/lorebook/index.ts` | Orchestration | 98-257 (main process), 40-97 (filtering and budgets) |
| `packages/shared/src/types/lorebook.ts` | Type definitions | 46-116 (LorebookEntry), 15-38 (Lorebook), 118-145 (conditions/schedule) |
| `packages/server/src/services/storage/lorebooks.storage.ts` | Database operations | 233-273 (create), 275-320 (update), 333-358 (reorder) |
| `packages/server/src/db/schema/lorebooks.ts` | Database schema | 6-25 (lorebooks table), 27-87 (entries table) |

### 3.2 Data Structures

**ActivatedEntry Result:**
```typescript
export interface ActivatedEntry {
  entry: LorebookEntry;
  matchedKeys: string[];      // Which keys triggered activation
  injectionOrder: number;     // Priority for injection
}
```

**ScanOptions Configuration:**
```typescript
export interface ScanOptions {
  scanDepth?: number;                    // How many messages to scan (0 = all)
  gameState?: GameStateForScanning | null;  // Current game state
  timingStates?: Map<string, EntryTimingState>;  // Timing tracking
  currentMessageIndex?: number;          // For timing calculations
  chatEmbedding?: number[] | null;       // For semantic matching
  semanticThreshold?: number;            // Default 0.3
}
```

**EntryTimingState:**
```typescript
export interface EntryTimingState {
  lastActivatedAt: number | null;        // Message index of last activation
  stickyCount: number;                   // Consecutive messages active
  cooldownRemaining: number;             // Messages until next activation
  delayRemaining: number;                // Messages before first activation
}
```

### 3.3 Token Budget Implementation

**File:** `packages/server/src/services/lorebook/prompt-injector.ts` (Lines 118-142)

```typescript
export function applyTokenBudget(activatedEntries: ActivatedEntry[], tokenBudget: number): ActivatedEntry[] {
  if (tokenBudget <= 0) return activatedEntries;

  const CHARS_PER_TOKEN = 4;
  let totalTokens = 0;
  const result: ActivatedEntry[] = [];

  // Sort: constant entries first, then by order
  const sorted = [...activatedEntries].sort((a, b) => {
    if (a.entry.constant && !b.entry.constant) return -1;
    if (!a.entry.constant && b.entry.constant) return 1;
    return a.entry.order - b.entry.order;
  });

  for (const entry of sorted) {
    const entryTokens = Math.ceil(entry.entry.content.length / CHARS_PER_TOKEN);
    if (totalTokens + entryTokens > tokenBudget) {
      break;  // Budget exhausted
    }
    totalTokens += entryTokens;
    result.push(entry);
  }

  return result;
}
```

**Line 122:** Rough estimate of 4 characters per token  
**Line 126:** Constant entries get priority  
**Line 133:** Stops when budget exceeded

### 3.4 Per-Lorebook Token Budgets

**File:** `packages/server/src/services/lorebook/index.ts` (Lines 76-97)

```typescript
export function applyPerLorebookTokenBudgets(
  activatedEntries: ActivatedEntry[],
  lorebooksById: ReadonlyMap<string, Pick<Lorebook, "tokenBudget">>,
): ActivatedEntry[] {
  if (activatedEntries.length === 0) return [];

  const grouped = new Map<string, ActivatedEntry[]>();
  for (const entry of activatedEntries) {
    const list = grouped.get(entry.entry.lorebookId) ?? [];
    list.push(entry);
    grouped.set(entry.entry.lorebookId, list);
  }

  const budgeted: ActivatedEntry[] = [];
  for (const [lorebookId, group] of grouped) {
    const budget = lorebooksById.get(lorebookId)?.tokenBudget ?? 0;
    budgeted.push(...applyTokenBudget(group, budget));
  }

  return budgeted.sort((a, b) => a.injectionOrder - b.injectionOrder);
}
```

**Line 82:** Groups entries by lorebook  
**Line 90:** Applies token budget per lorebook independently  
**Line 94:** Re-sorts all budgeted entries by injection order

---

## Advanced Features

### 4.1 Recursive Scanning

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 412-438)

```typescript
export function recursiveScan(
  messages: ScanMessage[],
  entries: LorebookEntry[],
  options: ScanOptions = {},
  maxDepth: number = 3,
): ActivatedEntry[] {
  let allActivated = scanForActivatedEntries(messages, entries, options);
  const activatedIds = new Set(allActivated.map((a) => a.entry.id));

  for (let depth = 0; depth < maxDepth; depth++) {
    // Build text from newly activated entries, excluding those with preventRecursion
    const newContent = allActivated
      .filter((a) => (!activatedIds.has(a.entry.id) || depth === 0) && !a.entry.preventRecursion)
      .map((a) => a.entry.content)
      .join("\n");

    if (!newContent) break;

    // Scan remaining entries against the content of activated entries
    const remaining = entries.filter((e) => !activatedIds.has(e.id));
    const newMessages: ScanMessage[] = [{ role: "system", content: newContent }];
    const newActivated = scanForActivatedEntries(newMessages, remaining, options);

    if (newActivated.length === 0) break;

    for (const a of newActivated) {
      activatedIds.add(a.entry.id);
      allActivated.push(a);
    }
  }

  return allActivated;
}
```

**Line 418:** Default max depth is 3  
**Line 422:** Scans content of activated entries for additional triggers  
**Line 424:** Entries with `preventRecursion=true` are excluded  
**Line 429:** Only scans entries not yet activated  
**Line 435:** Breaks early if no new activations

**Lorebook Configuration:**
- **File:** `packages/shared/src/types/lorebook.ts` (Line 27)
- `recursiveScanning: boolean` — Enable/disable per lorebook
- `maxRecursionDepth: number` — Max recursion depth (default 3)

### 4.2 Selective Activation

#### By Character
**File:** `packages/server/src/services/lorebook/index.ts` (Lines 40-60)

```typescript
export function filterRelevantLorebooks(lorebooks: RelevantLorebook[], filters?: LorebookFilters): RelevantLorebook[] {
  if (!filters) return lorebooks.filter((b) => b.enabled);

  const { chatId, characterIds = [], personaId, activeLorebookIds = [] } = filters;

  return lorebooks.filter((b) => {
    if (!b.enabled) return false;
    
    // Chat-scoped lorebooks
    if (b.chatId && b.chatId === chatId) return true;
    
    // Character-scoped lorebooks
    if (b.characterId && characterIds.includes(b.characterId)) return true;
    
    // Persona-scoped lorebooks
    if (b.personaId && b.personaId === personaId) return true;
    
    // Manually activated lorebooks
    if (activeLorebookIds.includes(b.id)) return true;
    
    // Global lorebooks (no scope)
    if (!b.chatId && !b.characterId && !b.personaId) return true;
    
    return false;
  });
}
```

**Line 46:** Chat-specific lorebooks activate only in that chat  
**Line 49:** Character books activate when that character is present  
**Line 52:** Persona books activate for active persona  
**Line 55:** Manual activation overrides scope  
**Line 58:** Global lorebooks always considered

#### Per-Chat Entry State Overrides

**File:** `packages/server/src/services/lorebook/index.ts` (Lines 201-240)

```typescript
// Decrement ephemeral counters for activated entries.
// When per-chat overrides are provided, track the countdown in those overrides
// so each chat has independent ephemeral state.
let updatedOverrides: Record<string, { ephemeral?: number | null; enabled?: boolean }> | undefined;

if (overrides) {
  // Per-chat tracking: write to overrides, leave global entry untouched
  updatedOverrides = { ...overrides };
  for (const a of budgetedActivated) {
    if (a.entry.ephemeral !== null && a.entry.ephemeral > 0) {
      const current = overrides[a.entry.id]?.ephemeral ?? a.entry.ephemeral;
      const next = current - 1;
      updatedOverrides[a.entry.id] = { ephemeral: next > 0 ? next : 0, enabled: next > 0 };
    }
  }
}
```

**Line 206:** Per-chat entry state allows different ephemeral counts per chat  
**Line 209:** Ephemeral countdown tracked in chat metadata  
**Line 212:** Entry auto-disables when ephemeral reaches 0

### 4.3 Timing Controls

**File:** `packages/server/src/services/lorebook/keyword-scanner.ts` (Lines 204-231)

```typescript
function checkTiming(
  entry: LorebookEntry,
  timingState: EntryTimingState | undefined,
  currentMessageIndex: number,
): boolean {
  // Delay: skip if delay messages haven't passed yet
  if (entry.delay !== null && entry.delay > 0) {
    if (!timingState || timingState.delayRemaining > 0) {
      return false;
    }
  }

  // Cooldown: skip if cooldown period hasn't elapsed
  if (entry.cooldown !== null && entry.cooldown > 0) {
    if (timingState && timingState.cooldownRemaining > 0) {
      return false;
    }
  }

  // Sticky: auto-activate if within sticky window
  if (entry.sticky !== null && entry.sticky > 0) {
    if (timingState && timingState.stickyCount > 0) {
      return true;  // Force activation during sticky period
    }
  }

  return true;
}
```

**Line 207:** Delay prevents activation for N messages  
**Line 215:** Cooldown requires N messages between activations  
**Line 223:** Sticky keeps entry active for N messages after trigger

### 4.4 Cascading Triggers

Cascading triggers are implemented via **recursive scanning**:

1. Entry A activates from chat message
2. Entry A's content is scanned for keywords
3. Entry B activates if its keywords appear in Entry A's content
4. Process repeats up to `maxRecursionDepth`

**Prevention:**
- Set `preventRecursion: true` on Entry A to block cascading
- Adjust `maxRecursionDepth` on lorebook to limit cascade depth

### 4.5 Entry Disabling Logic

**Ephemeral Entries:**
```typescript
ephemeral: number | null  // Activations remaining
```
- Each activation decrements counter
- Entry auto-disables when counter reaches 0
- Per-chat tracking via `entryStateOverrides`

**Manual Disabling:**
```typescript
enabled: boolean  // Master on/off switch
```

**Probability-Based:**
```typescript
probability: number | null  // 0-100 chance of activation
```
- Checked on every scan even if keywords match
- `null` or `100` = always active when triggered

---

## Integration with Generation Pipeline

### 5.1 Call Flow

```
POST /api/generate
  ↓
generateRoute()
  ↓
processLorebooks(db, messages, gameState, options)
  ↓
├─ filterRelevantLorebooks() — Select lorebooks by scope
├─ applyLorebookDefaults() — Inherit lorebook scan depth
├─ scanForActivatedEntries() OR recursiveScan()
├─ applyPerLorebookTokenBudgets() — Per-lorebook budgets
└─ processActivatedEntries() — Build injection blocks
     ↓
     ├─ applyTokenBudget() — Global token budget
     ├─ buildWorldInfoBlocks() — Position 0/1 injection
     └─ getDepthInjectedEntries() — Position 2+ injection
  ↓
assemblePrompt()
  ↓
├─ Inject worldInfoBefore/worldInfoAfter at markers
└─ injectAtDepth() for depth entries
  ↓
Send to LLM
```

### 5.2 Prompt Assembly Integration

**File:** `packages/server/src/services/prompt/assembler.ts` (Lines 215-363)

The lorebook system provides three injection outputs:

1. **worldInfoBefore** — Injected via `{WORLD_INFO}` marker (before character card)
2. **worldInfoAfter** — Injected after character definition
3. **depthEntries** — Injected at specific depths in message history

```typescript
// From assemblePrompt function
const lorebookResult = await processLorebooks(app.db, scanMessages, null, {
  chatId,
  characterIds,
  personaId,
  activeLorebookIds,
  chatEmbedding: null,
  entryStateOverrides: undefined,
});

const loreContent = [lorebookResult.worldInfoBefore, lorebookResult.worldInfoAfter]
  .filter(Boolean)
  .join("\n");

// Depth entries injected separately
finalMessages = injectAtDepth(finalMessages, lorebookResult.depthEntries);
```

### 5.3 Agent Hook Integration

**Pre-Generation Agents:**
- **Knowledge Retrieval** — Summarizes lorebook entries via LLM
- **Knowledge Router** — Selects relevant entries by ID

**File:** `packages/server/src/services/agents/agent-pipeline.ts` (Lines 212-228)

```typescript
export async function runPreGenerationAgents(
  agents: ResolvedAgent[],
  context: AgentContext,
  onResult?: AgentResultCallback,
  agentTypeFilter?: (agentType: string) => boolean,
): Promise<AgentInjection[]> {
  const filtered = agentTypeFilter ? agents.filter((a) => agentTypeFilter(a.type)) : agents;
  const results = await executePhase(filtered, "pre_generation", context, onResult);

  const injections: AgentInjection[] = [];
  for (const result of results) {
    if (!result.success) continue;

    if (result.type === "context_injection" || result.type === "director_event") {
      const text = typeof result.data === "string" ? result.data : ((result.data as any)?.text ?? "");
      if (text) injections.push({ agentType: result.agentType, text });
    }
  }

  return injections;
}
```

**Line 224:** Agents can inject additional context alongside lorebooks  
**Line 225:** Knowledge agents process lorebook content and return refined text

---

## Summary

Marinara Engine's lorebook system implements:

✅ **Multi-stage trigger matching** — Keywords, regex, semantic similarity  
✅ **Advanced filtering** — Conditions, schedules, probability, timing  
✅ **Three injection strategies** — Before/after character, depth-based  
✅ **Recursive scanning** — Cascading triggers with configurable depth  
✅ **Token budgeting** — Per-lorebook and global limits  
✅ **Selective activation** — By character, persona, or chat  
✅ **Group selection** — Weighted lottery within groups  
✅ **State management** — Ephemeral counters, per-chat overrides  
✅ **Hook integration** — Seamless integration with generation pipeline

**Key Innovation:** The combination of keyword scanning, semantic fallback, recursive activation, and flexible injection strategies creates a powerful context management system that adapts to conversation flow while respecting token constraints.

---

**End of Document**
