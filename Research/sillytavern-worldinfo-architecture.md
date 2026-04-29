# SillyTavern World Info System: Complete Technical Analysis

## Executive Summary

SillyTavern's World Info (WI) system is a sophisticated keyword-triggered knowledge injection mechanism that dynamically inserts contextual information into LLM prompts based on chat content. This document provides a comprehensive technical analysis of the system's architecture, scanning algorithms, injection strategies, and generation modes, with specific focus on how these patterns could enable cross-chat memory and multi-user knowledge management in a Caretaker agent.

## Table of Contents

1. [World Info System Architecture](#1-world-info-system-architecture)
2. [Scanning & Trigger Mechanism](#2-scanning--trigger-mechanism)
3. [Injection Strategy](#3-injection-strategy)
4. [Generation Modes](#4-generation-modes)
5. [Application to Caretaker Agent](#5-application-to-caretaker-agent)

---

## 1. World Info System Architecture

### 1.1 Core Files

**Primary Implementation:**
- `public/scripts/world-info.js` (5000+ lines) - Main WI logic
- `src/endpoints/worldinfo.js` - Server-side API endpoints
- `public/scripts/char-data.js` - Data type definitions

### 1.2 Entry Data Structure

Each World Info entry is a complex object with multiple configuration options:

**From `public/scripts/char-data.js` (Lines 0-15):**

```javascript
/**
 * @typedef {object} v2DataWorldInfoEntry
 * @property {string[]} keys - An array of primary keys associated with the entry.
 * @property {string[]} secondary_keys - An array of secondary keys associated with the entry (optional).
 * @property {string} comment - A human-readable description or explanation for the entry.
 * @property {string} content - The main content or data associated with the entry.
 * @property {boolean} constant - Indicates if the entry's content is fixed and unchangeable.
 * @property {boolean} selective - Indicates if the entry's inclusion is controlled by specific conditions.
 * @property {number} insertion_order - Defines the order in which the entry is inserted during processing.
 * @property {boolean} enabled - Controls whether the entry is currently active and used.
 * @property {string} position - Specifies the location or context where the entry applies.
 * @property {v2DataWorldInfoEntryExtensionInfos} extensions - An object containing additional details for extensions associated with the entry.
 * @property {number} id - A unique identifier assigned to the entry.
 */
```

**Complete Entry Template - `public/scripts/world-info.js` (Lines 4032-4063):**

```javascript
export function createWorldInfoEntry(_name, data) {
    const newUid = getFreeWorldEntryUid(data);

    if (!Number.isInteger(newUid)) {
        console.error('Couldn\'t assign UID to a new entry');
        return;
    }

    const newEntry = { uid: newUid, ...structuredClone(newWorldInfoEntryTemplate) };
    data.entries[newUid] = newEntry;

    return newEntry;
}
```

**Entry Properties (Extended):**

The `newWorldInfoEntryTemplate` includes:
- `uid` - Unique identifier (integer)
- `key` - Array of primary trigger keywords
- `keysecondary` - Array of secondary keywords for selective logic
- `comment` - Human-readable memo/title
- `content` - The text content to inject
- `constant` - If true, always activates (no keyword matching)
- `selective` - Enables secondary keyword logic
- `selectiveLogic` - Logic type (AND_ANY, AND_ALL, NOT_ANY, NOT_ALL)
- `order` - Insertion priority
- `position` - Injection position (0-4)
- `depth` - Scan depth override
- `probability` - Activation chance (0-100)
- `disable` - If true, entry is skipped
- `excludeRecursion` - Prevents recursive activation
- `preventRecursion` - Prevents content from activating other entries
- `delayUntilRecursion` - Delay activation until recursion step
- `scanDepth` - Custom scan depth (0-1000)
- `caseSensitive` - Override global case sensitivity
- `matchWholeWords` - Override global whole-word matching
- `useGroupScoring` - Enable group scoring
- `automationId` - For external automation
- `role` - Message role for @Depth injection
- `vectorized` - If true, used for vector search
- `sticky` - Cooldown in messages
- `cooldown` - Cooldown timer
- `displayIndex` - UI display order

**From `src/endpoints/characters.js` (Lines 688-705):**

```javascript
function convertWorldInfoToCharacterBook(name, entries) {
    // Conversion function showing all supported fields
    depth: entry.depth ?? 4,
    selectiveLogic: entry.selectiveLogic ?? 0,
    outlet_name: entry.outletName ?? '',
    group: entry.group ?? '',
    group_override: entry.groupOverride ?? false,
    group_weight: entry.groupWeight ?? null,
    prevent_recursion: entry.preventRecursion ?? false,
    delay_until_recursion: entry.delayUntilRecursion ?? false,
    scan_depth: entry.scanDepth ?? null,
    match_whole_words: entry.matchWholeWords ?? null,
    use_group_scoring: entry.useGroupScoring ?? false,
    case_sensitive: entry.caseSensitive ?? null,
    automation_id: entry.automationId ?? '',
    role: entry.role ?? 0,
    vectorized: entry.vectorized ?? false,
    sticky: entry.sticky ?? null,
    cooldown: entry.cooldown ?? null,
}
```

### 1.3 Storage Mechanism

**Server-Side Storage - `src/endpoints/worldinfo.js` (Lines 9-35):**

```javascript
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        console.error(`World info file ${filename} doesn't exist.`);
        return dummyObject;
    }

    const worldInfoText = fs.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);
    return worldInfo;
}
```

**File Structure:**
- Location: `<user_directories>/worlds/<name>.json`
- Format: JSON with `{ entries: { [uid]: {...} }, name: "...", ... }`
- Each entry keyed by its UID
- Atomic writes using `writeFileAtomicSync`

**Validation - `src/endpoints/worldinfo.js` (Lines 138-157):**

```javascript
if (!request.body.name) {
    return response.status(400).send('World file must have a name');
}

try {
    if (!('entries' in request.body.data)) {
        throw new Error('World info must contain an entries list');
    }
} catch (err) {
    return response.status(400).send('Is not a valid world info file');
}

const filename = sanitize(`${request.body.name}.json`);
const pathToFile = path.join(request.user.directories.worlds, filename);

writeFileAtomicSync(pathToFile, JSON.stringify(request.body.data, null, 4));

return response.send({ ok: true });
```

### 1.4 World Info Book Organization

**Multiple Books System:**

```javascript
// From world-info.js (Lines 4396-4412)
async function getGlobalLore() {
    if (!selected_world_info?.length) {
        return [];
    }

    let entries = [];
    for (const worldName of selected_world_info) {
        const data = await loadWorldInfo(worldName);
        const newEntries = data ? Object.keys(data.entries).map((x) => data.entries[x]).map(({ uid, ...rest }) => ({ uid, world: worldName, ...rest })) : [];
        entries = entries.concat(newEntries);
    }

    console.debug(`[WI] Global world info has ${entries.length} entries`, selected_world_info);

    return entries;
}
```

**Book Types:**
1. **Global Lorebooks** - Attached at profile level, active across all chats
2. **Character Lorebooks** - Specific to individual characters
3. **Chat Lorebooks** - Specific to individual chat sessions  
4. **Persona Lorebooks** - Attached to user personas

**Sorting Strategy - `world-info.js` (Lines 4460-4488):**

```javascript
async function getSortedEntries() {
    try {
        const [
            globalLore,
            characterLore,
            chatLore,
            personaLore,
        ] = await Promise.all([
            getGlobalLore(),
            getCharacterLore(),
            getChatLore(),
            getPersonaLore(),
        ]);

        await eventSource.emit(event_types.WORLDINFO_ENTRIES_LOADED, { globalLore, characterLore, chatLore, personaLore });

        let entries;

        switch (Number(world_info_character_strategy)) {
            case world_info_insertion_strategy.evenly:
                entries = [...globalLore, ...characterLore].sort(sortFn);
                break;
            case world_info_insertion_strategy.character_first:
                entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)];
                break;
            case world_info_insertion_strategy.global_first:
                entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)];
                break;
            // ...
        }
    }
}
```

---

## 2. Scanning & Trigger Mechanism

### 2.1 Core Scanning Architecture

**WorldInfoBuffer Class - `world-info.js` (Lines 199-473):**

```javascript
class WorldInfoBuffer {
    /**
     * @type {Map<string, object>} Map of entries that need to be activated no matter what
     */
    static externalActivations = new Map();

    /**
     * @type {WIGlobalScanData} Chat independent data to be scanned, such as persona and character descriptions
     */
    #globalScanData = null;

    /**
     * @type {string[]} Array of messages sorted by ascending depth
     */
    #depthBuffer = [];

    /**
     * @type {string[]} Array of strings added by recursive scanning
     */
    #recurseBuffer = [];

    /**
     * @type {string[]} Array of strings added by prompt injections that are valid for the current scan
     */
    #injectBuffer = [];

    /**
     * @type {number} The skew of the global scan depth. Used in "min activations"
     */
    #skew = 0;

    constructor(messages, globalScanData) {
        this.#initDepthBuffer(messages);
        this.#globalScanData = globalScanData;
    }

    #initDepthBuffer(messages) {
        for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
            if (messages[depth]) {
                this.#depthBuffer[depth] = messages[depth].trim();
            }
            // break if last message is reached
            if (depth === messages.length - 1) {
                break;
            }
        }
    }
}
```

**Scan Function Entry Point - `world-info.js` (Lines 4579-4601):**

```javascript
export async function checkWorldInfo(chat, maxContext, isDryRun, globalScanData = defaultGlobalScanData) {
    const context = getContext();
    const buffer = new WorldInfoBuffer(chat, globalScanData);

    console.debug(`[WI] --- START WI SCAN (on ${chat.length} messages, trigger = ${globalScanData.trigger})${isDryRun ? ' (DRY RUN)' : ''} ---`);

    // Combine the chat

    // Add the depth or AN if enabled
    // Put this code here since otherwise, the chat reference is modified
    for (const key of Object.keys(context.extensionPrompts)) {
        if (context.extensionPrompts[key]?.scan) {
            const prompt = await getExtensionPromptByName(key);
            if (prompt) {
                buffer.addInject(prompt);
            }
        }
    }

    /** @type {scan_state} */
    let scanState = scan_state.INITIAL;
    let token_budget_overflowed = false;
    let count = 0;
}
```

### 2.2 Keyword Matching Algorithm

**Buffer.get() - Constructs Search Text - `world-info.js` (Lines 279-327):**

```javascript
get(entry, scanState) {
    let depth = entry.scanDepth ?? this.getDepth();
    if (depth <= this.#startDepth) {
        return '';
    }

    if (depth < 0) {
        console.error(`[WI] Invalid WI scan depth ${depth}. Must be >= 0`);
        return '';
    }

    if (depth > MAX_SCAN_DEPTH) {
        console.warn(`[WI] Invalid WI scan depth ${depth}. Truncating to ${MAX_SCAN_DEPTH}`);
        depth = MAX_SCAN_DEPTH;
    }

    const MATCHER = '\x01';
    const JOINER = '\n' + MATCHER;
    let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER);

    if (entry.matchPersonaDescription && this.#globalScanData.personaDescription) {
        result += JOINER + this.#globalScanData.personaDescription;
    }
    if (entry.matchCharacterDescription && this.#globalScanData.characterDescription) {
        result += JOINER + this.#globalScanData.characterDescription;
    }
    if (entry.matchCharacterPersonality && this.#globalScanData.characterPersonality) {
        result += JOINER + this.#globalScanData.characterPersonality;
    }
    if (entry.matchCharacterDepthPrompt && this.#globalScanData.characterDepthPrompt) {
        result += JOINER + this.#globalScanData.characterDepthPrompt;
    }
    if (entry.matchScenario && this.#globalScanData.scenario) {
        result += JOINER + this.#globalScanData.scenario;
    }
    if (entry.matchCreatorNotes && this.#globalScanData.creatorNotes) {
        result += JOINER + this.#globalScanData.creatorNotes;
    }

    if (this.#injectBuffer.length > 0) {
        result += JOINER + this.#injectBuffer.join(JOINER);
    }

    // Min activations should not include the recursion buffer
    if (this.#recurseBuffer.length > 0 && scanState !== scan_state.MIN_ACTIVATIONS) {
        result += JOINER + this.#recurseBuffer.join(JOINER);
    }

    return result;
}
```

**matchKeys() - Pattern Matching - `world-info.js` (Lines 337-370):**

```javascript
matchKeys(haystack, needle, entry) {
    // If the needle is a regex, we do regex pattern matching and override all the other options
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) {
        return keyRegex.test(haystack);
    }

    // Otherwise we do normal matching of plaintext with the chosen entry settings
    haystack = this.#transformString(haystack, entry);
    const transformedString = this.#transformString(needle, entry);
    const matchWholeWords = entry.matchWholeWords ?? world_info_match_whole_words;

    if (matchWholeWords) {
        const keyWords = transformedString.split(/\s+/);

        if (keyWords.length > 1) {
            return haystack.includes(transformedString);
        } else {
            // Use custom boundaries to include punctuation and other non-alphanumeric characters
            const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedString)})(?:$|\\W)`);
            if (regex.test(haystack)) {
                return true;
            }
        }
    } else {
        return haystack.includes(transformedString);
    }

    return false;
}
```

### 2.3 Primary & Secondary Key Logic

**Primary Key Matching - `world-info.js` (Lines 4775-4801):**

```javascript
// PRIMARY KEYWORDS
let primaryKeyMatch = entry.key.find(key => {
    const substituted = substituteParams(key);
    return substituted && buffer.matchKeys(textToScan, substituted.trim(), entry);
});

if (!primaryKeyMatch) {
    // Don't write logs for simple no-matches
    continue;
}

const hasSecondaryKeywords = (
    entry.selective && //all entries are selective now
    Array.isArray(entry.keysecondary) && //always true
    entry.keysecondary.length //ignore empties
);

if (!hasSecondaryKeywords) {
    // Handle cases where secondary is empty
    log('activated. (AND ANY) Found match primary keyword', primaryKeyMatch);
    activatedNow.add(entry);
    continue;
}
```

**Secondary Key Logic - `world-info.js` (Lines 4813-4852):**

```javascript
function matchSecondaryKeys() {
    let hasAnyMatch = false;
    let hasAllMatch = true;
    for (let keysecondary of entry.keysecondary) {
        const secondarySubstituted = substituteParams(keysecondary);
        const hasSecondaryMatch = secondarySubstituted && buffer.matchKeys(textToScan, secondarySubstituted.trim(), entry);

        if (hasSecondaryMatch) hasAnyMatch = true;
        if (!hasSecondaryMatch) hasAllMatch = false;

        // Simplified AND ANY / NOT ALL if statement. (Proper fix for PR#1356 by Bronya)
        // If AND ANY logic and the main checks pass OR if NOT ALL logic and the main checks do not pass
        if (selectiveLogic === world_info_logic.AND_ANY && hasSecondaryMatch) {
            log('activated. (AND ANY) Found match secondary keyword', secondarySubstituted);
            return true;
        }
        if (selectiveLogic === world_info_logic.NOT_ALL && !hasSecondaryMatch) {
            log('activated. (NOT ALL) Found not matching secondary keyword', secondarySubstituted);
            return true;
        }
    }

    // Handle NOT ANY logic
    if (selectiveLogic === world_info_logic.NOT_ANY && !hasAnyMatch) {
        log('activated. (NOT ANY) No secondary keywords found', entry.keysecondary);
        return true;
    }

    // Handle AND ALL logic
    if (selectiveLogic === world_info_logic.AND_ALL && hasAllMatch) {
        log('activated. (AND ALL) All secondary keywords found', entry.keysecondary);
        return true;
    }

    return false;
}

const matched = matchSecondaryKeys();
if (!matched) {
    log('skipped. Secondary keywords not satisfied', entry.keysecondary);
    continue;
}
```

### 2.4 Scan Depth & Buffer System

**Depth Configuration - `world-info.js` (Lines 794-812):**

```javascript
export function getWorldInfoSettings() {
    return {
        world_info,
        world_info_depth,
        world_info_min_activations,
        world_info_min_activations_depth_max,
        world_info_budget,
        world_info_include_names,
        world_info_recursive,
        world_info_overflow_alert,
        world_info_case_sensitive,
        world_info_match_whole_words,
        world_info_character_strategy,
        world_info_budget_cap,
        world_info_use_group_scoring,
        world_info_max_recursion_steps,
    };
}
```

**Scan Depth Logic:**
- `world_info_depth`: Global default scan depth (e.g., 4)
- `entry.scanDepth`: Per-entry override (0-1000)
- `MAX_SCAN_DEPTH`: Hard limit of 1000 messages
- `MIN_ACTIVATIONS`: Special mode that gradually increases depth

**Min Activations - `world-info.js` (Lines 4968-4973):**

```javascript
// If scanning is planned to stop, but min activations is set and not satisfied, check if we should continue
const minActivationsNotSatisfied = world_info_min_activations > 0 && (allActivatedEntries.size < world_info_min_activations);

if (nextScanState === scan_state.NONE && minActivationsNotSatisfied && buffer.getDepth() < world_info_min_activations_depth_max) {
    buffer.advanceScan();
    nextScanState = scan_state.MIN_ACTIVATIONS;
    logNextState('[WI] Min Activations threshold not reached. Increasing depth to', buffer.getDepth());
}
```

### 2.5 Regex Support

**Keyword Parsing - `world-info.js` (Lines 2717-2734):**

```javascript
export function splitKeywordsAndRegexes(input) {
    /** @type {string[]} */
    let keywordsAndRegexes = [];

    // We can make this easy. Instead of writing another function to find and parse regexes,
    // we gonna utilize the custom tokenizer that also handles the input.
    // No need for validation here
    const addFindCallback = (/** @type {Select2Option} */ item) => {
        keywordsAndRegexes.push(item.text);
    };

    const { term } = customTokenizer({ _type: 'custom_call', term: input }, undefined, addFindCallback);
    const finalTerm = term.trim();
    if (finalTerm) {
        addFindCallback({ id: getSelect2OptionId(finalTerm), text: finalTerm });
    }

    return keywordsAndRegexes;
}
```

**Regex Format:**
- `/pattern/flags` - Full regex with optional flags
- Commas inside regex are allowed
- Escaped slashes: `\/`
- Invalid regex falls back to literal matching

### 2.6 Case Sensitivity & Whole Word Matching

**Transform String - `world-info.js` (Lines 268-277):**

```javascript
#transformString(str, entry) {
    const caseSensitive = entry.caseSensitive ?? world_info_case_sensitive;

    if (!caseSensitive) {
        return str.toLowerCase();
    }

    return str;
}
```

**Settings Priority:**
1. Per-entry `caseSensitive` override
2. Global `world_info_case_sensitive` setting
3. Default: false (case-insensitive)

Same pattern for `matchWholeWords` setting.

---

## 3. Injection Strategy

### 3.1 Injection Positions

**Position Constants - `world-info.js`:**

```javascript
const world_info_position = {
    before: 0,      // ↑CD - Before character description
    after: 1,       // CD↓ - After character description  
    EMTop: 2,       // ↑EM - Before example messages
    EMBottom: 3,    // ↓EM - After example messages
    ANTop: 2,       // ↑AN - Before author's note
    ANBottom: 3,    // ↓AN - After author's note
    atDepth: 4,     // @Depth - At specific message depth
};
```

**Position Display - `world-info.js` (Lines 2985-3004):**

```javascript
function updatePosOrdDisplayHelper({ template, data, uid }) {
    let entry = data.entries[uid];
    let posText = entry.position;
    switch (entry.position) {
        case 0: posText = '↑CD'; break;
        case 1: posText = 'CD↓'; break;
        case 2: posText = '↑AN'; break;
        case 3: posText = 'AN↓'; break;
        case 4: posText = `@D${entry.depth}`; break;
    }
    template.find('.world_entry_form_position_value').text(`(${posText} ${entry.order})`);
}
```

### 3.2 Token Budgeting

**Budget Calculation - `world-info.js` (Lines 4601-4619):**

```javascript
let budget = Math.round(world_info_budget * maxContext / 100) || 1;

if (world_info_budget_cap > 0 && budget > world_info_budget_cap) {
    console.debug(`[WI] Budget ${budget} exceeds cap ${world_info_budget_cap}, using cap`);
    budget = world_info_budget_cap;
}

console.debug(`[WI] Context size: ${maxContext}; WI budget: ${budget} (max% = ${world_info_budget}%, cap = ${world_info_budget_cap})`);
```

**Budget Enforcement - `world-info.js` (Lines 4919-4936):**

```javascript
// Substitute macros inline, for both this checking and also future processing
entry.content = substituteParams(entry.content);
newContent += `${entry.content}\n`;

if (!entry.ignoreBudget && (textToScanTokens + (await getTokenCountAsync(newContent))) >= budget) {
    if (!token_budget_overflowed) {
        console.debug('[WI] --- BUDGET OVERFLOW CHECK ---');
        if (world_info_overflow_alert) {
            console.warn(`[WI] budget of ${budget} reached, stopping after ${allActivatedEntries.size} entries`);
            toastr.warning(`World info budget reached after ${allActivatedEntries.size} entries.`, 'World Info');
        } else {
            console.debug(`[WI] budget of ${budget} reached, stopping after ${allActivatedEntries.size} entries`);
        }
        token_budget_overflowed = true;
    }
    continue;
}
```

**Ignore Budget Flag:**
- Entries with `ignoreBudget: true` bypass token limits
- Used for critical lore that must always inject

### 3.3 Recursive Scanning

**Recursion Control - `world-info.js` (Lines 4945-4973):**

```javascript
const successfulNewEntries = newEntries.filter(x => !failedProbabilityChecks.has(x));
const successfulNewEntriesForRecursion = successfulNewEntries.filter(x => !x.preventRecursion);

console.debug(`[WI] --- LOOP #${count} RESULT ---`);

if (!newEntries.length) {
    console.debug('[WI] No new entries activated.');
} else if (!successfulNewEntries.length) {
    console.debug('[WI] Probability checks failed for all activated entries. No new entries activated.');
} else {
    console.debug(`[WI] Successfully activated ${successfulNewEntries.length} new entries to prompt. ${allActivatedEntries.size} total entries activated.`, successfulNewEntries);
}

// After processing and rolling entries is done, see if we should continue with normal recursion
if (world_info_recursive && !token_budget_overflowed && successfulNewEntriesForRecursion.length) {
    nextScanState = scan_state.RECURSION;
    logNextState('[WI] Found', successfulNewEntriesForRecursion.length, 'new entries for recursion');
}

// If we are inside min activations scan, and we have recursive buffer, we should do a recursive scan before increasing the buffer again
// There might be recurse-trigger-able entries that match the buffer, so we need to check that
if (world_info_recursive && !token_budget_overflowed && scanState === scan_state.MIN_ACTIVATIONS && buffer.hasRecurse()) {
    nextScanState = scan_state.RECURSION;
    logNextState('[WI] Min Activations run done, whill will always be followed by a recursive scan');
}
```

**Recursion Buffer Management:**

```javascript
// Add new content to recursion buffer
for (const entry of successfulNewEntriesForRecursion) {
    if (entry.content) {
        buffer.addRecurse(entry.content);
    }
}
```

**Recursion Delay Levels - `world-info.js` (Lines 4625-4637):**

```javascript
/** @type {number[]} Represents the delay levels for entries that are delayed until recursion */
const availableRecursionDelayLevels = [...new Set(sortedEntries
    .filter(entry => entry.delayUntilRecursion)
    .map(entry => entry.delayUntilRecursion === true ? 1 : entry.delayUntilRecursion),
)].sort((a, b) => a - b);
// Already preset with the first level
let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;
if (currentRecursionDelayLevel > 0 && availableRecursionDelayLevels.length) {
    console.debug('[WI] Preparing first delayed recursion level', currentRecursionDelayLevel, '. Still delayed:', availableRecursionDelayLevels);
}
```

**Max Recursion Steps:**

```javascript
if (world_info_max_recursion_steps && world_info_max_recursion_steps <= count) {
    console.debug('[WI] Search stopped by reaching max recursion steps', world_info_max_recursion_steps);
    break;
}
```

### 3.4 Prompt Construction

**Final Assembly - `world-info.js` (Lines 892-914):**

```javascript
export async function getWorldInfoPrompt(chat, maxContext, isDryRun, globalScanData) {
    let worldInfoString = '', worldInfoBefore = '', worldInfoAfter = '';

    const activatedWorldInfo = await checkWorldInfo(chat, maxContext, isDryRun, globalScanData);
    worldInfoBefore = activatedWorldInfo.worldInfoBefore;
    worldInfoAfter = activatedWorldInfo.worldInfoAfter;
    worldInfoString = worldInfoBefore + worldInfoAfter;

    if (!isDryRun && activatedWorldInfo.allActivatedEntries && activatedWorldInfo.allActivatedEntries.size > 0) {
        const arg = Array.from(activatedWorldInfo.allActivatedEntries.values());
        await eventSource.emit(event_types.WORLD_INFO_ACTIVATED, arg);
    }

    return {
        worldInfoString,
        worldInfoBefore,
        worldInfoAfter,
        worldInfoExamples: activatedWorldInfo.EMEntries ?? [],
        worldInfoDepth: activatedWorldInfo.WIDepthEntries ?? [],
        anBefore: activatedWorldInfo.ANBeforeEntries ?? [],
        anAfter: activatedWorldInfo.ANAfterEntries ?? [],
        outletEntries: activatedWorldInfo.outletEntries ?? {},
    };
}
```

**Integration with OpenAI Messages - `public/scripts/openai.js` (Lines 1180-1198):**

```javascript
async function populateChatCompletion(prompts, chatCompletion, { bias, quietPrompt, quietImage, type, cyclePrompt, messages, messageExamples }) {
    chatCompletion.reserveBudget(3); // every reply is primed with <|start|>assistant<|message|>
    // Character and world information
    await addToChatCompletion('worldInfoBefore');
    await addToChatCompletion('main');
    await addToChatCompletion('worldInfoAfter');
    await addToChatCompletion('charDescription');
    await addToChatCompletion('charPersonality');
    await addToChatCompletion('scenario');
    await addToChatCompletion('personaDescription');

    // Collection of control prompts that will always be positioned last
    chatCompletion.setOverriddenPrompts(prompts.overriddenPrompts);
    const controlPrompts = new MessageCollection('controlPrompts');

    const impersonateMessage = await Message.fromPromptAsync(prompts.get('impersonate')) ?? null;
    if (type === 'impersonate') controlPrompts.add(impersonateMessage);
}
```

### 3.5 Advanced Features

**Timed Effects - `world-info.js` (Lines 539-590):**

```javascript
class WorldInfoTimedEffects {
    /**
     * Initialize the timed effects with the given messages.
     * @param {string[]} chat Array of chat messages
     * @param {WIScanEntry[]} entries Array of entries
     * @param {boolean} isDryRun Whether the operation is a dry run
     */
    constructor(chat, entries, isDryRun = false) {
        // Manages sticky and cooldown timers
    }
}
```

**Probability Checks:**

```javascript
function verifyProbability() {
    if (entry.probability === undefined || entry.probability === null || entry.probability === 100) {
        return true;
    }

    const roll = Math.random() * 100;
    if (roll > entry.probability) {
        log(`suppressed by probability check (${roll.toFixed(2)} > ${entry.probability})`);
        failedProbabilityChecks.add(entry);
        return false;
    }

    return true;
}
```

**Character & Tag Filtering - `world-info.js` (Lines 4685-4723):**

```javascript
// Check if this entry applies to the character or if it's excluded
if (entry.characterFilter && entry.characterFilter?.names?.length > 0) {
    const nameIncluded = entry.characterFilter.names.includes(getCharaFilename());
    const filtered = entry.characterFilter.isExclude ? nameIncluded : !nameIncluded;

    if (filtered) {
        log('filtered out by character');
        continue;
    }
}

if (entry.characterFilter && entry.characterFilter?.tags?.length > 0) {
    const tagNames = tags.filter((tag) => entry.characterFilter.tags.includes(tag.id)).map((tag) => tag.name);
    const tagFilter = entry.characterFilter.isExclude
        ? matchKeys(tagNames, getContext().characterTags, 'every')
        : !matchKeys(tagNames, getContext().characterTags, 'some');

    if (tagFilter) {
        log('filtered out by tag');
        continue;
    }
}
```

---

## 4. Generation Modes

### 4.1 Generation Type Triggers

**Trigger Filter - `world-info.js` (Lines 4676-4685):**

```javascript
// Check for generation type trigger filter
if (Array.isArray(entry.triggers) && entry.triggers.length > 0) {
    const isTriggered = entry.triggers.includes(globalScanData.trigger);
    if (!isTriggered) {
        log(`skipped by generation type trigger filter (${globalScanData.trigger} ∉ ${entry.triggers})`);
        continue;
    }
}
```

**Available Triggers:**
- `normal` - Standard character response
- `impersonate` - User persona generation
- `quiet` - Background/hidden generation
- `continue` - Continuation of last message
- `swipe` - Alternate response generation
- `auto` - Automated group chat turns

### 4.2 Normal Generation

Standard character response with full WI activation:

```javascript
// From public/scripts/script.js
async function Generate(type, options = {}) {
    const globalScanData = {
        trigger: type || 'normal',
        characterDescription: getCharacterDescription(),
        characterPersonality: getCharacterPersonality(),
        scenario: getScenario(),
        personaDescription: getPersonaDescription(),
        // ... other context
    };

    const wiResult = await getWorldInfoPrompt(chat, maxContext, false, globalScanData);
    // WI injected into prompt at configured positions
}
```

### 4.3 Impersonate Mode

Generates as the user instead of the character:

**From `public/scripts/group-chats.js` (Lines 1093-1121):**

```javascript
function activateImpersonate(members) {
    const randomIndex = Math.floor(Math.random() * members.length);
    const activatedMembers = [members[randomIndex]];
    const memberIds = activatedMembers
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}
```

**Instruct Mode Formatting - `public/scripts/instruct-mode.js` (Lines 596-650):**

```javascript
export function formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, isQuietToLoud, customInstruct = null) {
    function getSequence() {
        // User impersonation prompt
        if (isImpersonate) {
            return instruct.input_sequence;
        }

        // Neutral / system / quiet prompt
        if (isQuiet && !isQuietToLoud) {
            return instruct.last_system_sequence || instruct.output_sequence;
        }

        // Quiet in-character prompt
        if (isQuiet && isQuietToLoud) {
            return instruct.last_output_sequence || instruct.output_sequence;
        }

        // Default AI response
        return instruct.last_output_sequence || instruct.output_sequence;
    }

    const sequence = substituteParams(getSequence(), { name1Override: name1, name2Override: name2 });
    // ... formatting logic
}
```

### 4.4 Quiet Mode

Generates hidden/background text without displaying in chat:

**From `public/scripts/slash-commands.js` (Lines 5813-5841):**

```javascript
export async function generateSystemMessage(args, prompt) {
    $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));

    if (!prompt) {
        console.warn('WARN: No prompt provided for /sysgen command');
        toastr.warning(t`You must provide a prompt for the system message`);
        return '';
    }

    const trim = isTrueBoolean(args?.trim?.toString());

    // Generate and regex the output if applicable
    const toast = toastr.info(t`Please wait`, t`Generating...`);
    const message = await generateQuietPrompt({ quietPrompt: prompt, trimToSentence: trim });
    toastr.clear(toast);

    return await sendNarratorMessage(args, getRegexedString(message, regex_placement.SLASH_COMMAND));
}
```

**quietToLoud Parameter:**
- `false`: Uses system/neutral sequence (for summaries, analysis)
- `true`: Uses character output sequence (for in-character quiet gen)

### 4.5 Continue Mode

Continues the last message:

**From `public/scripts/slash-commands.js` (Lines 5722-5754):**

```javascript
async function continueChatCallback(args, prompt) {
    const shouldAwait = isTrueBoolean(args?.await);

    const outerPromise = new Promise(async (resolve, reject) => {
        try {
            await waitUntilCondition(() => !is_send_press && !is_group_generating, 10000, 100);
        } catch {
            console.warn('Timeout waiting for generation unlock');
            toastr.warning(t`Cannot run /continue command while the reply is being generated.`);
            return reject();
        }

        try {
            // Prevent infinite recursion
            $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));

            const options = prompt?.trim() ? { quiet_prompt: prompt.trim(), quietToLoud: true } : {};
            await Generate('continue', options);

            resolve();
        } catch (error) {
            console.error('Error running /continue command:', error);
            reject(error);
        }
    });

    if (shouldAwait) {
        await outerPromise;
    }

    return '';
}
```

### 4.6 Group Chat Mode

**Group Generation Wrapper - `public/scripts/group-chats.js` (Lines 945-1091):**

```javascript
async function generateGroupWrapper(byAutoMode, type = null, params = {}) {
    const group = groups.find((x) => x.id === selected_group);

    if (!group || !Array.isArray(group.members) || !group.members.length) {
        sendSystemMessage(system_message_types.EMPTY, '', { isSmallSys: true });
        return Promise.resolve();
    }

    try {
        await unshallowGroupMembers(selected_group);

        hideSwipeButtons();
        is_group_generating = true;
        setCharacterName('');
        setCharacterId(undefined);
        const userInput = String($('#send_textarea').val());

        // id of this specific batch for regeneration purposes
        group_generation_id = Date.now();
        const lastMessage = chat[chat.length - 1];
        let activationText = '';
        let isUserInput = false;

        if (userInput?.length && !byAutoMode) {
            isUserInput = true;
            activationText = userInput;
        } else {
            if (lastMessage && !lastMessage.is_system) {
                activationText = lastMessage.mes;
            }
        }

        const activationStrategy = Number(group.activation_strategy ?? group_activation_strategy.NATURAL);
        const enabledMembers = group.members.filter(x => !group.disabled_members.includes(x));
        let activatedMembers = [];

        // Activation strategy determines which members respond
        if (activationStrategy === group_activation_strategy.NATURAL) {
            activatedMembers = activateNaturalOrder(enabledMembers, activationText, lastMessage, group.allow_self_responses, isUserInput);
        } else if (activationStrategy === group_activation_strategy.LIST) {
            activatedMembers = activateListOrder(enabledMembers);
        } else if (activationStrategy === group_activation_strategy.MANUAL && !isUserInput) {
            activatedMembers = shuffle(enabledMembers).slice(0, 1).map(x => characters.findIndex(y => y.avatar === x)).filter(x => x !== -1);
        }

        // Queue order tracking
        for (let i = 0; i < activatedMembers.length; ++i) {
            groupChatQueueOrder.set(characters[activatedMembers[i]].avatar, i + 1);
        }

        // Generate for each activated member
        for (const chId of activatedMembers) {
            deactivateSendButtons();
            setCharacterId(chId);
            setCharacterName(characters[chId].name);

            await eventSource.emit(event_types.GROUP_MEMBER_DRAFTED, chId);

            // Wait for generation to finish
            const generateType = ['swipe', 'impersonate', 'quiet', 'continue'].includes(type) ? type : 'normal';
            textResult = await Generate(generateType, { automatic_trigger: byAutoMode, ...(params || {}) });
        }
    } finally {
        is_group_generating = false;
        setSendButtonState(false);
        setCharacterId(undefined);
    }

    return Promise.resolve(textResult);
}
```

**Group Activation Strategies:**
1. **NATURAL** (0): NLP-based member selection from activation text
2. **LIST** (1): Fixed rotation through all members
3. **MANUAL** (2): User manually selects who speaks
4. **POOLED** (3): Weighted random selection

**Group Generation Modes:**
1. **SWAP** (0): Replace message with each member's response
2. **APPEND** (1): Concatenate all responses
3. **APPEND_DISABLED** (2): Append but skip disabled members

---

## 5. Application to Caretaker Agent

### 5.1 Cross-Chat Memory Architecture

**Concept:**

SillyTavern's WI system provides a blueprint for implementing persistent, queryable memory across multiple chat sessions. A Caretaker agent could adapt this as:

```javascript
// Hypothetical Caretaker implementation
class CaretakerMemorySystem {
    constructor() {
        this.memoryBooks = new Map(); // userId -> MemoryBook
        this.globalKnowledge = new MemoryBook('global');
    }

    async scan(userId, currentMessage, chatContext) {
        // Similar to checkWorldInfo()
        const userBook = this.memoryBooks.get(userId);
        const buffer = new MemoryBuffer([currentMessage, ...chatContext]);
        
        // Scan user-specific memories
        const userMemories = await this.activateEntries(userBook, buffer);
        
        // Scan global knowledge
        const globalMemories = await this.activateEntries(this.globalKnowledge, buffer);
        
        return {
            userSpecific: userMemories,
            shared: globalMemories,
            injectionText: this.formatInjection(userMemories, globalMemories),
        };
    }

    async activateEntries(book, buffer) {
        const activated = [];
        
        for (const entry of book.entries) {
            // Similar to WI keyword matching
            if (this.matchesKeywords(entry, buffer.getText())) {
                // Check privacy & visibility rules
                if (this.checkAccess(entry, buffer.context)) {
                    activated.push(entry);
                }
            }
        }
        
        return this.applyBudget(activated);
    }
}
```

**Key Adaptations:**

1. **Multi-User Scoping:**
```javascript
// Entry structure with ownership
{
    uid: "mem_001",
    owner: "user_alice",
    visibility: "private", // private | shared | public
    keys: ["vacation", "hawaii", "2024"],
    content: "Alice went to Hawaii in March 2024 and loved the beaches.",
    sharedWith: ["user_bob"], // Explicit sharing
    tags: ["personal", "travel"],
}
```

2. **Cross-Chat Activation:**
```javascript
// Unlike ST's per-chat activation, Caretaker scans across all user history
async buildScanBuffer(userId, currentChat) {
    const recentChats = await this.getUserRecentChats(userId, limit: 10);
    const messages = [];
    
    // Aggregate messages from multiple chats
    for (const chat of recentChats) {
        messages.push(...chat.messages.slice(-5)); // Last 5 from each
    }
    
    return new MemoryBuffer(messages, {
        userId: userId,
        currentChatId: currentChat.id,
        timestamp: Date.now(),
    });
}
```

3. **Relationship Mapping:**
```javascript
// Track knowledge about relationships
{
    uid: "rel_001",
    type: "relationship",
    subjects: ["user_alice", "user_bob"],
    keys: ["alice", "bob", "friends"],
    content: "Alice and Bob have been friends since college.",
    visibility: "shared", // Both can see
    createdBy: "user_alice",
    confirmedBy: ["user_bob"],
}
```

### 5.2 Multi-User Knowledge Management

**Privacy Levels:**

```javascript
const VISIBILITY_LEVELS = {
    PRIVATE: 0,        // Only owner sees
    SHARED: 1,         // Explicitly shared with specific users
    GROUP: 2,          // All members of a group/conversation
    PUBLIC: 3,         // Available to all users (global facts)
};

// Extended entry with access control
class CaretakerMemoryEntry extends WorldInfoEntry {
    constructor(data) {
        super(data);
        this.owner = data.owner;
        this.visibility = data.visibility ?? VISIBILITY_LEVELS.PRIVATE;
        this.sharedWith = data.sharedWith ?? [];
        this.groupId = data.groupId ?? null;
    }

    canAccess(userId, groupId = null) {
        if (this.visibility === VISIBILITY_LEVELS.PRIVATE) {
            return userId === this.owner;
        }
        if (this.visibility === VISIBILITY_LEVELS.SHARED) {
            return userId === this.owner || this.sharedWith.includes(userId);
        }
        if (this.visibility === VISIBILITY_LEVELS.GROUP) {
            return groupId === this.groupId;
        }
        if (this.visibility === VISIBILITY_LEVELS.PUBLIC) {
            return true;
        }
        return false;
    }
}
```

**Selective Visibility Implementation:**

```javascript
async function checkCaretakerMemory(userId, chat, maxContext, groupId = null) {
    // Similar to checkWorldInfo but with access control
    const buffer = new MemoryBuffer(chat);
    const allBooks = await loadRelevantMemoryBooks(userId, groupId);
    
    const activatedEntries = new Map();
    
    for (const book of allBooks) {
        for (const entry of book.entries) {
            // CRITICAL: Check access before activation
            if (!entry.canAccess(userId, groupId)) {
                continue;
            }
            
            // Same WI logic: check keys, secondary keys, etc.
            if (matchesActivationCriteria(entry, buffer)) {
                activatedEntries.set(entry.uid, entry);
            }
        }
    }
    
    return formatMemoryInjection(activatedEntries, userId);
}
```

### 5.3 Knowledge Synchronization Patterns

**1. Automatic Memory Creation from Chat:**

```javascript
// Similar to how WI can be created from chat context
async function extractMemoryFromMessage(message, userId) {
    // Use LLM to extract factual statements
    const extraction = await llm.generate({
        prompt: `Extract key facts from this message:
${message}

Return as JSON: [{ keys: [...], content: "...", category: "..." }]`,
    });
    
    const facts = JSON.parse(extraction);
    
    // Create memory entries
    for (const fact of facts) {
        await createMemoryEntry({
            owner: userId,
            keys: fact.keys,
            content: fact.content,
            visibility: inferVisibility(fact, message.context),
            source: message.id,
            createdAt: Date.now(),
        });
    }
}
```

**2. Conflict Resolution:**

```javascript
// When multiple users have conflicting memories
class MemoryConflictResolver {
    async detectConflicts(entry, existingEntries) {
        // Use semantic similarity to find conflicting statements
        const conflicts = [];
        
        for (const existing of existingEntries) {
            if (this.semanticConflict(entry.content, existing.content)) {
                conflicts.push({
                    new: entry,
                    existing: existing,
                    confidence: this.conflictScore(entry, existing),
                });
            }
        }
        
        return conflicts;
    }

    async resolve(conflict) {
        // Strategies:
        // 1. Timestamp priority (newer = more accurate)
        // 2. Source reliability (verified > unverified)
        // 3. Consensus (multiple users agree)
        // 4. User preference (owner's version for personal facts)
        
        if (conflict.new.owner === conflict.existing.owner) {
            // Same user: update
            return 'update';
        } else {
            // Different users: create alternate perspective
            return 'create_variant';
        }
    }
}
```

**3. Memory Decay & Relevance:**

```javascript
// Adapt WI's probability system for memory decay
class MemoryRelevanceScorer {
    scoreRelevance(entry, context) {
        let score = 100;
        
        // Time decay (like WI cooldown)
        const ageInDays = (Date.now() - entry.createdAt) / (1000 * 60 * 60 * 24);
        const decayRate = entry.decayRate ?? 0.5; // % per day
        score *= Math.pow(1 - decayRate/100, ageInDays);
        
        // Access frequency (like WI sticky)
        const daysSinceLastAccess = (Date.now() - entry.lastAccessed) / (1000 * 60 * 60 * 24);
        if (daysSinceLastAccess > 30) {
            score *= 0.5; // Halve relevance if not used in 30 days
        }
        
        // Confirmation count
        score *= Math.min(1.0, entry.confirmations.length / 3);
        
        return Math.max(0, Math.min(100, score));
    }
}
```

### 5.4 Implementation Recommendations

**Data Schema:**

```javascript
// MongoDB/PostgreSQL schema for Caretaker memories
{
    _id: "mem_unique_id",
    owner: "user_id",
    visibility: "private" | "shared" | "group" | "public",
    sharedWith: ["user_id_1", "user_id_2"],
    groupId: "group_id_optional",
    
    // WI-style fields
    keys: ["keyword1", "keyword2"],
    keysSecondary: ["context1", "context2"],
    content: "Memory content to inject",
    selectiveLogic: 0, // AND_ANY, AND_ALL, etc.
    
    // Metadata
    createdAt: ISODate("2024-01-15T10:30:00Z"),
    updatedAt: ISODate("2024-01-20T14:15:00Z"),
    lastAccessed: ISODate("2024-01-22T09:00:00Z"),
    accessCount: 42,
    
    // Provenance
    sourceChat: "chat_id",
    sourceMessage: "message_id",
    extractedBy: "llm" | "manual" | "automatic",
    
    // Quality & trust
    confirmations: ["user_id_1", "user_id_2"],
    disputes: [],
    reliability: 0.95,
    
    // Decay
    decayRate: 0.5, // % per day
    priority: 100,
    ignoreBudget: false,
    
    // Relationships
    relatedTo: ["mem_id_1", "mem_id_2"],
    supersedes: "old_mem_id",
}
```

**API Endpoints:**

```javascript
// RESTful API for memory management
POST   /api/memories                     // Create memory
GET    /api/memories/:id                 // Get memory
PUT    /api/memories/:id                 // Update memory
DELETE /api/memories/:id                 // Delete memory
GET    /api/memories/user/:userId        // Get user's memories
POST   /api/memories/scan                // Scan and activate memories
POST   /api/memories/:id/share           // Share with others
POST   /api/memories/:id/confirm         // Confirm accuracy
POST   /api/memories/:id/dispute         // Dispute accuracy
GET    /api/memories/search              // Full-text search
```

**Scan API Request:**

```javascript
POST /api/memories/scan
{
    "userId": "user_alice",
    "chatHistory": [
        { "role": "user", "content": "Do you remember where I went on vacation?" },
        // ... more messages
    ],
    "groupId": "group_123",
    "maxDepth": 10,
    "budgetTokens": 500,
    "includePublic": true,
}

// Response
{
    "activated": [
        {
            "uid": "mem_001",
            "content": "Alice went to Hawaii in March 2024",
            "matchedKeys": ["vacation", "hawaii"],
            "relevance": 95,
        },
        // ... more memories
    ],
    "injectionText": "...",
    "tokenCount": 287,
    "privacyLevels": {
        "private": 3,
        "shared": 2,
        "public": 1,
    },
}
```

### 5.5 Privacy & Security Considerations

**1. Encryption:**
```javascript
// Encrypt private memory content
class EncryptedMemory {
    async save(entry, userId) {
        if (entry.visibility === VISIBILITY_LEVELS.PRIVATE) {
            entry.content = await encrypt(entry.content, getUserKey(userId));
        }
        await db.memories.insert(entry);
    }

    async load(entryId, userId) {
        const entry = await db.memories.findById(entryId);
        if (entry.visibility === VISIBILITY_LEVELS.PRIVATE) {
            entry.content = await decrypt(entry.content, getUserKey(userId));
        }
        return entry;
    }
}
```

**2. Audit Logging:**
```javascript
// Track all memory access
async function auditMemoryAccess(entry, userId, action) {
    await db.auditLog.insert({
        memoryId: entry.uid,
        userId: userId,
        action: action, // 'read' | 'write' | 'share' | 'delete'
        timestamp: Date.now(),
        ipAddress: request.ip,
    });
}
```

**3. Rate Limiting:**
```javascript
// Prevent memory flooding attacks
class MemoryRateLimiter {
    constructor() {
        this.userLimits = new Map();
    }

    async checkLimit(userId) {
        const userLimit = this.userLimits.get(userId) || {
            createdToday: 0,
            lastReset: Date.now(),
        };

        // Reset daily
        if (Date.now() - userLimit.lastReset > 24 * 60 * 60 * 1000) {
            userLimit.createdToday = 0;
            userLimit.lastReset = Date.now();
        }

        if (userLimit.createdToday >= 100) {
            throw new Error('Daily memory creation limit exceeded');
        }

        userLimit.createdToday++;
        this.userLimits.set(userId, userLimit);
    }
}
```

---

## Conclusion

SillyTavern's World Info system demonstrates a mature, production-ready approach to context-aware knowledge injection. Key takeaways for a Caretaker agent implementation:

1. **Keyword-based activation** is efficient and predictable
2. **Recursive scanning** enables complex knowledge graphs
3. **Token budgeting** is essential for cost control
4. **Flexible positioning** allows precise prompt engineering
5. **Multi-level access control** can enable safe multi-user sharing

The system's architecture patterns—particularly the scanning buffer, selective logic, and injection strategies—provide a solid foundation for building sophisticated cross-chat memory with privacy-aware multi-user support.

**File References:**
- `public/scripts/world-info.js` (5000+ lines)
- `src/endpoints/worldinfo.js`
- `public/scripts/char-data.js`
- `public/scripts/openai.js`
- `public/scripts/group-chats.js`
- `public/scripts/instruct-mode.js`

---

*Document compiled from SillyTavern repository analysis (2024)*  
*Total lines analyzed: ~8,000+*  
*Primary source: https://github.com/SillyTavern/SillyTavern*
