# SillyTavern-MemoryBooks Extension: Technical Documentation

## Document Overview

**Repository**: https://github.com/aikohanasaki/SillyTavern-MemoryBooks  
**Purpose**: Automated world info/lorebook entry generation using LLMs  
**Integration**: SillyTavern 1.14.0+  
**Technology Stack**: JavaScript/Node.js, LLM APIs, JSON-based data structures  
**Last Research Date**: 2025  

**Document Scope**: This document provides comprehensive technical documentation on the SillyTavern-MemoryBooks extension, covering architecture, implementation details, automation mechanisms, configuration options, and practical application patterns. It complements existing SillyTavern world info documentation by focusing specifically on automated memory creation workflows.

---

## Table of Contents

1. [Extension Overview](#1-extension-overview)
2. [Automation Architecture](#2-automation-architecture)
3. [Memory Entry Generation](#3-memory-entry-generation)
4. [Configuration & Settings](#4-configuration--settings)
5. [Integration with World Info](#5-integration-with-world-info)
6. [Technical Implementation](#6-technical-implementation)
7. [Application to Caretaker Agent Scenarios](#7-application-to-caretaker-agent-scenarios)

---

## 1. Extension Overview

### 1.1 What is SillyTavern-MemoryBooks?

SillyTavern-MemoryBooks is a third-party extension for SillyTavern that automates the creation and management of world info (lorebook) entries using large language models (LLMs). The extension solves a critical workflow problem: manually creating world info entries from long conversations is time-consuming and error-prone. 

**Core Problem Solved**: As conversations grow, important context accumulates that should be preserved in the world info system for future reference. Manual extraction of this context requires users to:
- Read through long chat histories
- Identify important information
- Formulate concise summaries
- Generate appropriate keywords
- Create properly formatted lorebook entries

MemoryBooks automates this entire workflow, using LLMs to analyze conversation segments and generate structured world info entries.

### 1.2 Key Features

**Automated Memory Creation**:
- Trigger memory generation at configurable message intervals
- Automatically select conversation ranges ("scenes") for processing
- Generate title, content, and keywords via LLM analysis
- Insert entries directly into SillyTavern's world info system

**Scene Management**:
- Manual scene markers (start/end points) for precise control
- Visual indicators in chat interface (chevron buttons)
- Scene compilation with hidden message handling
- Token count estimation for scene sizes

**Profile Management**:
- Multiple LLM configuration profiles
- Per-profile API settings (endpoint, model, temperature)
- Built-in and custom prompt templates
- Profile-specific memory metadata tracking

**Side Prompts System**:
- Parallel AI tasks alongside main memory generation
- Tracker evaluation and updates
- Custom template support
- Runtime macro substitution

**Summary Consolidation** (Arc Analysis):
- Multi-tier memory aggregation
- Hierarchical summarization of existing entries
- Automatic keyword generation for consolidated summaries
- Reduces lorebook bloat from accumulated memories

**Lorebook Integration**:
- Auto-create and bind lorebooks to chats
- Configurable entry settings (position, order, depth)
- Metadata tracking (stmemorybooks flag, timestamps, profiles)
- Compatible with standard SillyTavern world info format

### 1.3 Integration Architecture

MemoryBooks integrates with SillyTavern through multiple extension points:

```javascript
// From index.js - Event hook registration
eventSource.on(event_types.MESSAGE_RECEIVED, handleAutoSummaryMessageReceived);
eventSource.on(event_types.GROUP_WRAPPER_FINISHED, handleAutoSummaryGroupFinished);
eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
```

**Extension Integration Points**:

1. **Event System**: Listens to SillyTavern events for message tracking and auto-triggering
2. **Slash Commands**: Registers custom commands for manual operation (`/stmb-create`, `/stmb-settings`, etc.)
3. **UI Injection**: Adds chevron buttons to chat messages for scene marking
4. **World Info API**: Directly manipulates lorebook entries through SillyTavern's data structures
5. **Settings API**: Stores extension configuration in SillyTavern's settings system
6. **Chat API**: Accesses chat history and message data for scene compilation

### 1.4 Workflow Overview

**Basic Memory Creation Workflow**:

1. **Scene Selection**:
   - User marks start/end of conversation segment (manual)
   - OR extension auto-selects recent messages based on interval (automatic)

2. **Scene Compilation**:
   - Extract messages within range
   - Filter hidden/system messages based on settings
   - Compile into text format with metadata

3. **LLM Processing**:
   - Send compiled scene + prompt template to configured LLM
   - Request structured JSON response with title, content, keywords
   - Parse and validate response with error recovery

4. **Entry Creation**:
   - Validate lorebook existence (auto-create if needed)
   - Apply entry settings (position, order, constVectMode, etc.)
   - Insert entry with metadata and timestamps
   - Update UI and scene markers

5. **Post-Processing**:
   - Optionally hide processed messages
   - Update auto-summary baseline
   - Run side prompts if configured
   - Trigger consolidation if memory count exceeds threshold

### 1.5 Supported LLM Providers

MemoryBooks supports multiple LLM backends through SillyTavern's unified API system:

- **OpenAI**: GPT-3.5, GPT-4, GPT-4 Turbo
- **Anthropic**: Claude 2, Claude 3 (Haiku, Sonnet, Opus)
- **OpenRouter**: Access to multiple providers through single API
- **Custom Endpoints**: Any OpenAI-compatible API (KoboldAI, Text Generation WebUI, etc.)
- **Text Completion**: Legacy text completion API support

**API Configuration** (from `index.js`):
```javascript
async function getCurrentApiInfo() {
    const mainApi = main_api; // SillyTavern's active API
    const chatCompletionSettings = chat_completion_settings; // API-specific settings
    
    // Extract model, endpoint, API key based on active API type
    // Returns unified configuration object for memory generation
}
```

### 1.6 Version Requirements

**Minimum Requirements**:
- **SillyTavern**: Version 1.14.0 or higher
- **Browser**: Modern browser with ES6+ support
- **LLM Access**: At least one configured LLM API endpoint

**Recommended**:
- SillyTavern 1.14.0+ for full feature compatibility
- LLM with JSON mode support for reliable structured output
- API with sufficient context window (8K+ tokens recommended)

---

## 2. Automation Architecture

### 2.1 Automatic Memory Generation System

The core automation system is implemented in `autosummary.js` and centers on **message-based triggering**. The extension tracks messages in the current chat and automatically generates memory entries when configurable thresholds are reached.

**Core Concept**: Every N messages, the extension automatically analyzes the most recent conversation and creates a world info entry summarizing important information.

### 2.2 Message Tracking & Triggers

**Event-Based Message Counting** (from `autosummary.js`):

```javascript
/**
 * Handle MESSAGE_RECEIVED event for auto-summary tracking
 * Called after each assistant/character message
 */
function handleAutoSummaryMessageReceived() {
    // Get current chat context
    const chatId = getCurrentChatId();
    if (!chatId) return;
    
    // Check if auto-summary is enabled for this chat
    const chatMetadata = getChatMetadata();
    const autoSummaryEnabled = chatMetadata?.autoSummary ?? true;
    
    if (!autoSummaryEnabled) return;
    
    // Increment message counter
    checkAutoSummaryTrigger(chatId, /* isGroupFinished= */ false);
}

/**
 * Handle GROUP_WRAPPER_FINISHED for group chats
 * Called after all group members have responded
 */
function handleAutoSummaryGroupFinished() {
    const chatId = getCurrentChatId();
    if (!chatId) return;
    
    checkAutoSummaryTrigger(chatId, /* isGroupFinished= */ true);
}
```

**Trigger Logic**:

1. **Message Counter**: Tracks messages since last auto-summary
2. **Interval Setting**: User-configured threshold (e.g., every 10 messages)
3. **Buffer Setting**: Additional messages required before trigger (prevents premature triggering)
4. **Baseline**: Starting point from which to count (updated after each auto-summary)

**Trigger Calculation** (from `autosummary.js`):

```javascript
function checkAutoSummaryTrigger(chatId, isGroupFinished) {
    const settings = extension_settings.stmemorybooks;
    const interval = settings.autoSummaryInterval; // e.g., 10
    const buffer = settings.autoSummaryBuffer; // e.g., 2
    const baseline = getAutoSummaryBaseline(chatId); // e.g., message index 0
    
    const currentMessageIndex = getCurrentMessageIndex();
    const messagesSinceBaseline = currentMessageIndex - baseline;
    
    // Trigger condition: messages >= (interval + buffer)
    if (messagesSinceBaseline >= (interval + buffer)) {
        // Calculate scene range
        const sceneEnd = currentMessageIndex;
        const sceneStart = Math.max(baseline, sceneEnd - interval);
        
        // Execute memory generation
        executeMemoryGeneration({
            sceneStart: sceneStart,
            sceneEnd: sceneEnd,
            isAutomatic: true
        });
        
        // Update baseline for next trigger
        setAutoSummaryBaseline(chatId, sceneEnd + 1);
    }
}
```

### 2.3 Auto-Summary Settings

**Configuration Options** (from `index.js` settings initialization):

```javascript
// Default auto-summary settings
const defaultSettings = {
    autoSummaryInterval: 10,        // Messages between auto-summaries
    autoSummaryBuffer: 2,           // Extra messages before triggering
    autoSummaryEnabled: true,       // Global enable/disable
    autoSummaryOnlyForNew: false,   // Only for new messages after enabling
    
    // Scene selection settings
    autoHideMessages: false,        // Hide messages after summarizing
    includeHiddenMessages: false,   // Include hidden messages in scenes
    
    // Lorebook auto-creation
    autoCreateLorebook: true,       // Auto-create if none exists
    lorebookNamingTemplate: "{{char}} - {{chat}} - Memories", // Template for names
    autoBindLorebook: true          // Auto-bind created lorebooks to chat
};
```

**User-Facing Settings UI** (from `templates.js`):

```handlebars
<div class="autoSummarySettings">
    <label>
        <span>Auto-Summary Interval</span>
        <input type="number" name="autoSummaryInterval" 
               min="1" max="100" value="{{autoSummaryInterval}}" />
        <small>Generate memory every N messages</small>
    </label>
    
    <label>
        <span>Auto-Summary Buffer</span>
        <input type="number" name="autoSummaryBuffer" 
               min="0" max="20" value="{{autoSummaryBuffer}}" />
        <small>Extra messages before triggering</small>
    </label>
    
    <label>
        <input type="checkbox" name="autoSummaryEnabled" 
               {{#if autoSummaryEnabled}}checked{{/if}} />
        <span>Enable Auto-Summary</span>
    </label>
</div>
```

### 2.4 Group Chat Support

MemoryBooks has specialized support for SillyTavern group chats, where multiple AI characters participate in the same conversation.

**Group Chat Considerations**:

1. **Message Counting**: Uses `GROUP_WRAPPER_FINISHED` event instead of `MESSAGE_RECEIVED`
2. **Character Tracking**: Includes all group members in scene compilation
3. **Turn Completion**: Waits for all scheduled characters to respond before counting
4. **Consolidated Summaries**: Summaries can cover interactions between multiple characters

**Group Chat Event Handling** (from `autosummary.js`):

```javascript
// GROUP_WRAPPER_FINISHED fires after all characters in group have responded
function handleAutoSummaryGroupFinished() {
    const chatId = getCurrentChatId();
    const chatMetadata = getChatMetadata();
    
    // Check if this is actually a group chat
    if (!chatMetadata?.isGroup) {
        return; // Not a group, ignore
    }
    
    // Use same trigger logic as regular chats
    checkAutoSummaryTrigger(chatId, /* isGroupFinished= */ true);
}
```

**Group Message Compilation** (from `chatcompile.js`):

```javascript
function compileScene(startIndex, endIndex, options) {
    const chat = getContext().chat;
    let compiledText = "";
    
    for (let i = startIndex; i <= endIndex; i++) {
        const message = chat[i];
        
        // Include character name for group messages
        const speakerName = message.is_user 
            ? (message.name || "{{user}}")
            : (message.name || "{{char}}");
        
        // Format: "CharacterName: message text"
        compiledText += `${speakerName}: ${message.mes}\n\n`;
    }
    
    return compiledText;
}
```

### 2.5 Scene Selection & Compilation

**Scene**: A contiguous range of messages to be analyzed for memory creation. Scenes can be selected manually (user marks start/end) or automatically (based on message intervals).

**Manual Scene Selection** (from `sceneManager.js`):

```javascript
// User clicks chevron button on a message to mark start/end
function toggleSceneMarker(messageIndex, markerType) {
    const sceneMarkers = getSceneMarkers();
    
    if (markerType === 'start') {
        sceneMarkers.start = messageIndex;
    } else if (markerType === 'end') {
        sceneMarkers.end = messageIndex;
    }
    
    // Validate: start must be before end
    if (sceneMarkers.start !== null && sceneMarkers.end !== null) {
        if (sceneMarkers.start > sceneMarkers.end) {
            // Swap if reversed
            [sceneMarkers.start, sceneMarkers.end] = [sceneMarkers.end, sceneMarkers.start];
        }
    }
    
    saveSceneMarkers(sceneMarkers);
    updateAllButtonStates(); // Update UI
}
```

**Automatic Scene Selection** (from `autosummary.js`):

```javascript
function selectAutoScene() {
    const settings = extension_settings.stmemorybooks;
    const baseline = getAutoSummaryBaseline();
    const currentIndex = getCurrentMessageIndex();
    const interval = settings.autoSummaryInterval;
    
    // Scene = last N messages (where N = interval)
    const sceneEnd = currentIndex;
    const sceneStart = Math.max(0, sceneEnd - interval);
    
    return { sceneStart, sceneEnd };
}
```

**Scene Compilation Process** (from `chatcompile.js`):

```javascript
/**
 * Compile messages in scene range into text for LLM processing
 * Handles hidden messages, system messages, and formatting
 */
function compileScene(sceneStart, sceneEnd, options = {}) {
    const chat = getContext().chat;
    const settings = extension_settings.stmemorybooks;
    
    let compiled = "";
    let tokenCount = 0;
    let messageCount = 0;
    
    for (let i = sceneStart; i <= sceneEnd; i++) {
        const message = chat[i];
        
        // Skip hidden messages unless includeHiddenMessages is true
        if (message.is_system || message.extra?.isHidden) {
            if (!settings.includeHiddenMessages) {
                continue;
            }
        }
        
        // Format message
        const speaker = message.is_user ? "{{user}}" : (message.name || "{{char}}");
        const text = message.mes;
        
        compiled += `${speaker}: ${text}\n\n`;
        messageCount++;
        
        // Estimate tokens (rough approximation)
        tokenCount += estimateTokens(text);
    }
    
    return {
        text: compiled,
        tokenCount: tokenCount,
        messageCount: messageCount,
        sceneRange: { start: sceneStart, end: sceneEnd }
    };
}

// Token estimation utility
function estimateTokens(text) {
    // Rough approximation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
}
```

**Scene Statistics** (from `chatcompile.js`):

```javascript
function getSceneStats(sceneStart, sceneEnd) {
    const compiled = compileScene(sceneStart, sceneEnd);
    
    return {
        messageCount: compiled.messageCount,
        tokenCount: compiled.tokenCount,
        characterCount: compiled.text.length,
        sceneRange: `${sceneStart}-${sceneEnd}`
    };
}
```

### 2.6 Trigger Prevention & Edge Cases

**Prevention of Duplicate Triggers**:

```javascript
// Debouncing mechanism to prevent rapid-fire triggering
let autoSummaryInProgress = false;

async function checkAutoSummaryTrigger(chatId, isGroupFinished) {
    if (autoSummaryInProgress) {
        console.log("[MemoryBooks] Auto-summary already in progress, skipping");
        return;
    }
    
    // ... trigger logic ...
    
    if (shouldTrigger) {
        autoSummaryInProgress = true;
        try {
            await executeMemoryGeneration(/* ... */);
        } finally {
            autoSummaryInProgress = false;
        }
    }
}
```

**Edge Cases Handled**:

1. **Chat Changes**: Baseline resets when switching chats
2. **Message Deletion**: Baseline adjustment if messages removed
3. **Empty Chats**: No trigger if insufficient messages exist
4. **API Errors**: Failed generation doesn't update baseline (retry possible)
5. **Manual Override**: User can disable auto-summary per chat or globally

### 2.7 Baseline Management

The **baseline** is the message index from which the extension starts counting toward the next auto-summary. It's stored per-chat in metadata.

**Baseline Initialization** (from `index.js`):

```javascript
function initializeAutoSummaryBaseline(chatId) {
    const chatMetadata = getChatMetadata(chatId);
    
    if (chatMetadata.stmemorybooks_baseline === undefined) {
        // Set baseline to current message count on first initialization
        const currentIndex = getCurrentMessageIndex();
        chatMetadata.stmemorybooks_baseline = currentIndex;
        saveChatMetadata(chatId, chatMetadata);
    }
    
    return chatMetadata.stmemorybooks_baseline;
}
```

**Baseline Updates** (from `autosummary.js`):

```javascript
function updateBaseline(chatId, newBaseline) {
    const chatMetadata = getChatMetadata(chatId);
    chatMetadata.stmemorybooks_baseline = newBaseline;
    saveChatMetadata(chatId, chatMetadata);
    
    console.log(`[MemoryBooks] Baseline updated to ${newBaseline} for chat ${chatId}`);
}
```

**Baseline Reset Conditions**:

1. **Chat Changed**: New chat gets independent baseline
2. **Manual Memory Creation**: Optionally updates baseline to end of selected scene
3. **Failed Generation**: Baseline unchanged (allows retry)
4. **User Request**: Can manually reset via slash command

---

## 3. Memory Entry Generation

### 3.1 LLM-Based Memory Creation

Memory entry generation is the core function of MemoryBooks. The extension sends compiled conversation scenes to an LLM with specific instructions to extract and summarize information in a structured format.

**Generation Pipeline** (from `stmemory.js`):

```javascript
/**
 * Main memory creation function
 * Coordinates scene compilation, LLM generation, and entry creation
 */
async function createMemory(options = {}) {
    const {
        sceneStart,
        sceneEnd,
        profileId,
        customPrompt,
        isAutomatic = false
    } = options;
    
    // 1. Compile scene
    const scene = compileScene(sceneStart, sceneEnd);
    
    // 2. Prepare prompt
    const prompt = buildMemoryPrompt(scene, customPrompt);
    
    // 3. Send to LLM
    const rawResponse = await generateMemoryWithAI(prompt, profileId);
    
    // 4. Parse JSON response
    const parsedMemory = parseAIJsonResponse(rawResponse);
    
    // 5. Validate and normalize
    const validatedMemory = validateMemoryStructure(parsedMemory);
    
    // 6. Create lorebook entry
    const entryId = await addMemoryToLorebook(validatedMemory, {
        sceneRange: { start: sceneStart, end: sceneEnd },
        profileUsed: profileId,
        timestamp: Date.now(),
        isAutomatic: isAutomatic
    });
    
    // 7. Post-processing
    if (isAutomatic && extension_settings.stmemorybooks.autoHideMessages) {
        hideMessagesInRange(sceneStart, sceneEnd);
    }
    
    return entryId;
}
```

### 3.2 Prompt Engineering

MemoryBooks includes several built-in prompt templates optimized for different summarization styles. These are defined in `utils.js`.

**Built-in Prompt Presets** (from `utils.js`):

```javascript
const BUILT_IN_PROMPTS = {
    "summary": {
        name: "Summary (Default)",
        description: "Balanced summary with good detail",
        systemPrompt: `You are a memory extraction assistant. Analyze the following conversation and create a structured memory entry.

**Instructions**:
1. Generate a brief, descriptive title (2-8 words)
2. Write a concise summary of important information (2-4 sentences)
3. Extract 15-30 concrete keywords related to the scene

**Output Format** (JSON):
{
  "title": "Brief descriptive title",
  "content": "Concise summary of key information",
  "keywords": ["keyword1", "keyword2", "keyword3", ...]
}

**Conversation:**
{{scene}}

**Output (JSON only):**`
    },
    
    "synopsis": {
        name: "Synopsis",
        description: "Very brief high-level summary",
        systemPrompt: `Create a very brief synopsis of the following conversation.

Output JSON:
{
  "title": "2-5 word title",
  "content": "1-2 sentence synopsis",
  "keywords": ["key", "terms"]
}

Conversation:
{{scene}}

JSON Output:`
    },
    
    "comprehensive": {
        name: "Comprehensive",
        description: "Detailed summary with extensive keywords",
        systemPrompt: `Analyze this conversation in detail and create a comprehensive memory entry.

Requirements:
- Title: Descriptive, 3-10 words
- Content: Detailed summary, 5-8 sentences, preserve important details
- Keywords: 30-50 specific terms, including names, places, concepts, actions

JSON format:
{
  "title": "Descriptive title",
  "content": "Comprehensive multi-sentence summary",
  "keywords": ["extensive", "keyword", "list", ...]
}

Conversation:
{{scene}}

JSON:`
    },
    
    "minimal": {
        name: "Minimal",
        description: "Extremely concise",
        systemPrompt: `Summarize in minimal form.
JSON: {"title": "2-4 words", "content": "1 sentence", "keywords": ["few", "terms"]}

Scene: {{scene}}

Output:`
    }
};

function getBuiltInPresetPrompts() {
    return BUILT_IN_PROMPTS;
}
```

**Custom Prompt Support**:

Users can create custom prompts through the settings UI. Custom prompts are stored per-profile and can include:
- Custom system instructions
- Specific formatting requirements
- Domain-specific keyword extraction rules
- Alternative JSON schemas (with validation)

**Prompt Template Variables** (from `index.js`):

```handlebars
Available placeholders:
- {{scene}}      : Compiled conversation text
- {{char}}       : Character name
- {{user}}       : User name
- {{chat}}       : Chat/conversation title
- {{sceneStart}} : Starting message index
- {{sceneEnd}}   : Ending message index
- {{messageCount}}: Number of messages in scene
- {{tokenCount}} : Estimated token count
```

### 3.3 LLM Communication

**API Request Construction** (from `stmemory.js`):

```javascript
/**
 * Send prompt to LLM and get raw text response
 */
async function generateMemoryWithAI(prompt, profileId) {
    const profile = getProfile(profileId);
    const apiInfo = getCurrentApiInfo(); // From SillyTavern's active API
    
    // Build request payload based on API type
    let requestBody;
    
    if (apiInfo.type === 'openai' || apiInfo.type === 'claude') {
        // Chat completion format
        requestBody = {
            model: profile.model || apiInfo.model,
            messages: [
                {
                    role: "system",
                    content: "You are a memory extraction assistant."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: profile.temperature || 0.7,
            max_tokens: profile.maxTokens || 500,
            response_format: { type: "json_object" } // Request JSON mode if supported
        };
    } else {
        // Text completion format
        requestBody = {
            prompt: prompt,
            temperature: profile.temperature || 0.7,
            max_tokens: profile.maxTokens || 500
        };
    }
    
    // Send request through SillyTavern's generate API
    const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });
    
    const data = await response.json();
    
    // Extract text from response (format varies by API)
    const responseText = extractResponseText(data, apiInfo.type);
    
    return responseText;
}

function extractResponseText(data, apiType) {
    switch (apiType) {
        case 'openai':
            return data.choices[0].message.content;
        case 'claude':
            return data.content[0].text;
        case 'textcompletion':
            return data.choices[0].text;
        default:
            return data.text || data.content || "";
    }
}
```

### 3.4 JSON Parsing & Error Recovery

LLMs don't always produce perfectly formatted JSON. MemoryBooks includes robust parsing logic with multiple fallback strategies.

**JSON Parsing Pipeline** (from `stmemory.js`):

```javascript
/**
 * Parse LLM response with error recovery
 * Attempts multiple strategies to extract valid JSON
 */
function parseAIJsonResponse(rawText) {
    // Strategy 1: Direct parse
    try {
        return JSON.parse(rawText);
    } catch (e) {
        console.log("[MemoryBooks] Direct parse failed, attempting cleanup");
    }
    
    // Strategy 2: Extract JSON from markdown code blocks
    const codeBlockMatch = rawText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (codeBlockMatch) {
        try {
            return JSON.parse(codeBlockMatch[1]);
        } catch (e) {
            console.log("[MemoryBooks] Code block parse failed");
        }
    }
    
    // Strategy 3: Find first complete JSON object
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.log("[MemoryBooks] Regex extraction failed");
        }
    }
    
    // Strategy 4: Attempt repair
    try {
        const repaired = repairJson(rawText);
        return JSON.parse(repaired);
    } catch (e) {
        console.log("[MemoryBooks] JSON repair failed");
    }
    
    // Strategy 5: Fallback to structured extraction
    return fallbackExtraction(rawText);
}

/**
 * Attempt to repair common JSON errors
 */
function repairJson(text) {
    let repaired = text.trim();
    
    // Remove trailing commas before closing brackets
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
    
    // Ensure property names are quoted
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
    
    // Fix single quotes to double quotes
    repaired = repaired.replace(/'/g, '"');
    
    // Remove line breaks within strings (common error)
    repaired = repaired.replace(/"([^"]*)\n([^"]*)"/g, '"$1 $2"');
    
    return repaired;
}

/**
 * Fallback: Extract structure from unstructured text
 */
function fallbackExtraction(text) {
    console.log("[MemoryBooks] Using fallback extraction");
    
    // Look for patterns like "Title: ...", "Content: ...", "Keywords: ..."
    const titleMatch = text.match(/title[:\s]+([^\n]+)/i);
    const contentMatch = text.match(/content[:\s]+([^\n]+(?:\n(?!keywords:)[^\n]+)*)/i);
    const keywordsMatch = text.match(/keywords[:\s]+(.+)/is);
    
    const title = titleMatch ? titleMatch[1].trim() : "Untitled Memory";
    const content = contentMatch ? contentMatch[1].trim() : text.substring(0, 200);
    
    let keywords = [];
    if (keywordsMatch) {
        keywords = keywordsMatch[1]
            .split(/[,;\n]/)
            .map(k => k.trim())
            .filter(k => k.length > 0);
    }
    
    return { title, content, keywords };
}
```

### 3.5 Memory Entry Structure

**Standard Memory Format** (expected JSON structure):

```json
{
  "title": "Brief descriptive title (2-10 words)",
  "content": "Summary content (1-8 sentences)",
  "keywords": [
    "keyword1",
    "keyword2",
    "keyword3",
    "..."
  ]
}
```

**Keyword Generation Guidelines** (from built-in prompts):

- **Count**: 15-30 keywords (configurable by prompt preset)
- **Specificity**: Concrete terms, not abstract concepts
- **Variety**: Names, places, objects, actions, concepts
- **Scene-Specific**: Terms unique to this particular conversation
- **Lowercase**: Generally lowercase for consistency (LLM-dependent)
- **No Duplicates**: Each keyword should appear once

**Keyword Examples**:

Good keywords for a scene about a character visiting a market:
```json
[
  "market square",
  "fruit vendor",
  "haggling",
  "copper coins",
  "red apples",
  "merchant guild",
  "crowd",
  "pickpocket",
  "stolen purse",
  "guard patrol"
]
```

Poor keywords (too generic):
```json
[
  "place",
  "person",
  "event",
  "thing",
  "interaction"
]
```

### 3.6 Metadata & Entry Enrichment

MemoryBooks adds metadata to each generated entry for tracking and management.

**Entry Metadata Structure** (from `addlore.js`):

```javascript
function addMemoryToLorebook(memory, metadata) {
    const entry = {
        // Core content (from LLM)
        comment: memory.title,
        content: memory.content,
        key: memory.keywords,
        
        // Entry settings
        constant: false, // Not constant (can be activated/deactivated)
        selective: true, // Use selective activation
        order: metadata.order || 100,
        position: metadata.position || 'after_char', // Position in context
        depth: metadata.depth || 4, // Scan depth
        
        // MemoryBooks-specific metadata
        extensions: {
            stmemorybooks: {
                isMemory: true,
                profileUsed: metadata.profileUsed,
                sceneRange: metadata.sceneRange,
                timestamp: metadata.timestamp,
                isAutomatic: metadata.isAutomatic || false,
                tokenUsage: metadata.tokenUsage || null
            }
        },
        
        // Standard fields
        enabled: true,
        caseSensitive: false,
        probability: 100,
        
        // Keywords array (for compatibility)
        keys: memory.keywords
    };
    
    return entry;
}
```

**Metadata Fields Explained**:

- **`profileUsed`**: ID of the profile (LLM configuration) used to generate this memory
- **`sceneRange`**: `{start: N, end: M}` - message indices covered by this memory
- **`timestamp`**: Unix timestamp of creation
- **`isAutomatic`**: Boolean - was this auto-generated or manually created?
- **`tokenUsage`**: Optional token count if API provides it

**Position Options** (where entry is inserted in context):

- `"before_char"`: Before character definition
- `"after_char"`: After character definition (default)
- `"at_depth"`: At specified scan depth
- `"top"`: At very top of context
- `"bottom"`: At very bottom of context

### 3.7 Validation & Normalization

**Memory Validation** (from `stmemory.js`):

```javascript
function validateMemoryStructure(memory) {
    const errors = [];
    
    // Required fields
    if (!memory.title || typeof memory.title !== 'string') {
        errors.push("Missing or invalid 'title' field");
        memory.title = "Untitled Memory";
    }
    
    if (!memory.content || typeof memory.content !== 'string') {
        errors.push("Missing or invalid 'content' field");
        memory.content = "";
    }
    
    if (!Array.isArray(memory.keywords)) {
        errors.push("Missing or invalid 'keywords' array");
        memory.keywords = [];
    }
    
    // Normalize title
    memory.title = memory.title.trim().substring(0, 100);
    
    // Normalize content
    memory.content = memory.content.trim();
    if (memory.content.length > 10000) {
        console.warn("[MemoryBooks] Content exceeds 10k chars, truncating");
        memory.content = memory.content.substring(0, 10000);
    }
    
    // Normalize keywords
    memory.keywords = memory.keywords
        .filter(k => typeof k === 'string' && k.trim().length > 0)
        .map(k => k.trim().toLowerCase())
        .slice(0, 50); // Max 50 keywords
    
    // Remove duplicates
    memory.keywords = [...new Set(memory.keywords)];
    
    // Warn if issues found
    if (errors.length > 0) {
        console.warn("[MemoryBooks] Memory validation errors:", errors);
    }
    
    return memory;
}
```

### 3.8 Token Usage Tracking

**Token Tracking** (from `stmemory.js`):

```javascript
async function generateMemoryWithAI(prompt, profileId) {
    // ... send request ...
    
    const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });
    
    const data = await response.json();
    
    // Extract token usage if provided by API
    let tokenUsage = null;
    if (data.usage) {
        tokenUsage = {
            prompt_tokens: data.usage.prompt_tokens || 0,
            completion_tokens: data.usage.completion_tokens || 0,
            total_tokens: data.usage.total_tokens || 0
        };
    }
    
    return {
        text: extractResponseText(data, apiInfo.type),
        tokenUsage: tokenUsage
    };
}
```

Token usage is stored in metadata and can be used for:
- Cost estimation
- Debugging prompt size issues
- Optimization of prompt templates
- API quota monitoring

---

## 4. Configuration & Settings

### 4.1 Settings Architecture

MemoryBooks stores configuration in SillyTavern's extension settings system. Settings are hierarchical and include global defaults, per-profile overrides, and per-chat metadata.

**Settings Hierarchy**:

1. **Global Settings** (`extension_settings.stmemorybooks`): Default configuration for all chats
2. **Profile Settings** (`extension_settings.stmemorybooks.profiles[id]`): LLM-specific configurations
3. **Chat Metadata** (per-chat storage): Chat-specific overrides and state

### 4.2 Global Settings

**Complete Settings Object** (from `index.js` initialization):

```javascript
const defaultSettings = {
    // === AUTO-SUMMARY SETTINGS ===
    autoSummaryEnabled: true,
    autoSummaryInterval: 10,
    autoSummaryBuffer: 2,
    autoSummaryOnlyForNew: false,
    
    // === SCENE SETTINGS ===
    includeHiddenMessages: false,
    autoHideMessages: false,
    maxSceneMessages: 50,
    maxSceneTokens: 4000,
    
    // === LOREBOOK SETTINGS ===
    autoCreateLorebook: true,
    autoBindLorebook: true,
    lorebookNamingTemplate: "{{char}} - {{chat}} - Memories",
    defaultLorebookSettings: {
        position: 'after_char',
        order: 100,
        depth: 4
    },
    
    // === MEMORY SETTINGS ===
    memoryCountThreshold: 20,
    titleFormat: "{{title}}",
    enableMetadata: true,
    
    // === PROFILE SETTINGS ===
    defaultProfileId: 'default',
    profiles: {
        'default': {
            name: "Default Profile",
            model: null, // Use SillyTavern's active model
            temperature: 0.7,
            maxTokens: 500,
            promptPreset: 'summary'
        }
    },
    
    // === SIDE PROMPTS ===
    sidePromptsEnabled: false,
    sidePrompts: [],
    
    // === CONSOLIDATION (ARC ANALYSIS) ===
    arcAnalysisEnabled: false,
    arcAnalysisTiers: 3,
    arcAnalysisInterval: 10,
    
    // === UI SETTINGS ===
    showChevronButtons: true,
    confirmBeforeMemoryCreation: false,
    showNotifications: true
};

// Initialize settings on extension load
function initializeSettings() {
    if (!extension_settings.stmemorybooks) {
        extension_settings.stmemorybooks = Object.assign({}, defaultSettings);
        saveSettingsDebounced();
    }
}
```

### 4.3 Settings UI

The extension provides a comprehensive settings popup accessible via the extension menu or slash command `/stmb-settings`.

**Settings Popup Template** (from `templates.js` - abbreviated):

```handlebars
<div id="stmb-settings-popup" class="settings-popup">
    <h2>MemoryBooks Settings</h2>
    
    <!-- AUTO-SUMMARY TAB -->
    <div class="settings-tab" data-tab="autosummary">
        <h3>Auto-Summary Settings</h3>
        
        <label>
            <input type="checkbox" name="autoSummaryEnabled" 
                   {{#if autoSummaryEnabled}}checked{{/if}} />
            Enable Auto-Summary
        </label>
        
        <label>
            Interval (messages)
            <input type="number" name="autoSummaryInterval" 
                   value="{{autoSummaryInterval}}" min="1" max="100" />
            <small>Generate memory every N messages</small>
        </label>
        
        <label>
            Buffer (messages)
            <input type="number" name="autoSummaryBuffer" 
                   value="{{autoSummaryBuffer}}" min="0" max="20" />
            <small>Extra messages before triggering</small>
        </label>
        
        <label>
            <input type="checkbox" name="autoSummaryOnlyForNew" 
                   {{#if autoSummaryOnlyForNew}}checked{{/if}} />
            Only for new messages (don't backfill)
        </label>
    </div>
    
    <!-- LOREBOOK TAB -->
    <div class="settings-tab" data-tab="lorebook">
        <h3>Lorebook Settings</h3>
        
        <label>
            <input type="checkbox" name="autoCreateLorebook" 
                   {{#if autoCreateLorebook}}checked{{/if}} />
            Auto-create lorebook if none exists
        </label>
        
        <label>
            Naming Template
            <input type="text" name="lorebookNamingTemplate" 
                   value="{{lorebookNamingTemplate}}" />
            <small>Available: {{char}}, {{user}}, {{chat}}</small>
        </label>
        
        <h4>Default Entry Settings</h4>
        
        <label>
            Position
            <select name="defaultLorebookSettings.position">
                <option value="before_char">Before Character</option>
                <option value="after_char" selected>After Character</option>
                <option value="at_depth">At Depth</option>
            </select>
        </label>
        
        <label>
            Order
            <input type="number" name="defaultLorebookSettings.order" 
                   value="{{defaultLorebookSettings.order}}" />
        </label>
        
        <label>
            Scan Depth
            <input type="number" name="defaultLorebookSettings.depth" 
                   value="{{defaultLorebookSettings.depth}}" min="0" max="10" />
        </label>
    </div>
    
    <!-- PROFILES TAB -->
    <div class="settings-tab" data-tab="profiles">
        <h3>LLM Profiles</h3>
        
        <div class="profile-list">
            {{#each profiles}}
            <div class="profile-item" data-profile-id="{{@key}}">
                <h4>{{this.name}}</h4>
                <div class="profile-details">
                    <span>Model: {{this.model}}</span>
                    <span>Temp: {{this.temperature}}</span>
                    <span>Preset: {{this.promptPreset}}</span>
                </div>
                <div class="profile-actions">
                    <button class="edit-profile" data-profile-id="{{@key}}">Edit</button>
                    <button class="delete-profile" data-profile-id="{{@key}}">Delete</button>
                </div>
            </div>
            {{/each}}
        </div>
        
        <button id="new-profile-btn">New Profile</button>
    </div>
    
    <!-- SIDE PROMPTS TAB -->
    <div class="settings-tab" data-tab="sideprompts">
        <h3>Side Prompts</h3>
        
        <label>
            <input type="checkbox" name="sidePromptsEnabled" 
                   {{#if sidePromptsEnabled}}checked{{/if}} />
            Enable Side Prompts
        </label>
        
        <div class="side-prompts-list">
            {{#each sidePrompts}}
            <div class="side-prompt-item">
                <input type="text" value="{{this.name}}" />
                <button class="edit-side-prompt">Edit</button>
                <button class="delete-side-prompt">Delete</button>
            </div>
            {{/each}}
        </div>
        
        <button id="new-side-prompt-btn">New Side Prompt</button>
    </div>
    
    <!-- ARC ANALYSIS TAB -->
    <div class="settings-tab" data-tab="arcanalysis">
        <h3>Summary Consolidation (Arc Analysis)</h3>
        
        <label>
            <input type="checkbox" name="arcAnalysisEnabled" 
                   {{#if arcAnalysisEnabled}}checked{{/if}} />
            Enable Arc Analysis
        </label>
        
        <label>
            Trigger Threshold (memories)
            <input type="number" name="memoryCountThreshold" 
                   value="{{memoryCountThreshold}}" min="5" max="100" />
            <small>Consolidate when memory count exceeds this</small>
        </label>
        
        <label>
            Tiers
            <input type="number" name="arcAnalysisTiers" 
                   value="{{arcAnalysisTiers}}" min="2" max="5" />
            <small>Levels of summarization hierarchy</small>
        </label>
        
        <label>
            Tier Interval
            <input type="number" name="arcAnalysisInterval" 
                   value="{{arcAnalysisInterval}}" min="5" max="50" />
            <small>Memories per tier</small>
        </label>
    </div>
</div>
```

### 4.4 Profile Management

Profiles allow users to configure different LLM settings for different use cases (e.g., one profile for detailed summaries, another for quick synopses).

**Profile Structure** (from `profileManager.js`):

```javascript
const profileSchema = {
    name: "Profile Name",
    model: "gpt-4",                  // Model identifier
    temperature: 0.7,                // Generation randomness (0.0-2.0)
    maxTokens: 500,                  // Max output tokens
    promptPreset: "summary",         // Built-in preset ID or "custom"
    customPrompt: "",                // Custom prompt template (if preset is "custom")
    apiOverride: null,               // Optional: override SillyTavern's active API
    enabled: true                    // Can disable profiles without deleting
};
```

**Profile Management Functions** (from `profileManager.js`):

```javascript
// Create new profile
function newProfile() {
    const profileId = generateUniqueId();
    const profile = {
        name: "New Profile",
        model: null,
        temperature: 0.7,
        maxTokens: 500,
        promptPreset: "summary",
        customPrompt: "",
        apiOverride: null,
        enabled: true
    };
    
    extension_settings.stmemorybooks.profiles[profileId] = profile;
    saveSettingsDebounced();
    
    return profileId;
}

// Edit existing profile
function editProfile(profileId) {
    const profile = extension_settings.stmemorybooks.profiles[profileId];
    if (!profile) {
        console.error(`[MemoryBooks] Profile ${profileId} not found`);
        return;
    }
    
    // Show profile editor popup
    showProfileEditorPopup(profileId, profile);
}

// Delete profile
function deleteProfile(profileId) {
    if (profileId === 'default') {
        toastr.error("Cannot delete default profile");
        return;
    }
    
    delete extension_settings.stmemorybooks.profiles[profileId];
    saveSettingsDebounced();
    
    // Update UI
    refreshProfileList();
}

// Validate profile settings
function validateProfile(profile) {
    const errors = [];
    
    if (!profile.name || profile.name.trim().length === 0) {
        errors.push("Profile name is required");
    }
    
    if (profile.temperature < 0 || profile.temperature > 2) {
        errors.push("Temperature must be between 0 and 2");
        profile.temperature = Math.max(0, Math.min(2, profile.temperature));
    }
    
    if (profile.maxTokens < 1 || profile.maxTokens > 4000) {
        errors.push("Max tokens must be between 1 and 4000");
        profile.maxTokens = Math.max(1, Math.min(4000, profile.maxTokens));
    }
    
    return errors;
}
```

**Profile Selection Workflow**:

1. User opens memory creation popup (manual or automatic)
2. Dropdown shows available enabled profiles
3. Selected profile determines:
   - LLM model used
   - Temperature/creativity level
   - Prompt template
   - Token limits
4. Profile ID stored in entry metadata for tracking

### 4.5 Lorebook Naming Templates

**Template System** (from `autocreate.js`):

```javascript
function generateLorebookName(template) {
    const context = getContext();
    const char = context.name2 || "Character";
    const user = context.name1 || "User";
    const chat = context.chatId || "Chat";
    
    // Replace placeholders
    let name = template
        .replace(/\{\{char\}\}/g, char)
        .replace(/\{\{user\}\}/g, user)
        .replace(/\{\{chat\}\}/g, chat)
        .replace(/\{\{date\}\}/g, new Date().toLocaleDateString())
        .replace(/\{\{time\}\}/g, new Date().toLocaleTimeString());
    
    // Ensure uniqueness
    const existingLorebooks = getLorebookList();
    let finalName = name;
    let counter = 1;
    
    while (existingLorebooks.some(lb => lb.name === finalName)) {
        finalName = `${name} (${counter})`;
        counter++;
    }
    
    return finalName;
}
```

**Example Templates**:

- `"{{char}} - {{chat}} - Memories"` → "Alice - Conversation 5 - Memories"
- `"{{char}} Memories ({{date}})"` → "Alice Memories (1/15/2025)"
- `"{{user}}'s Notes on {{char}}"` → "John's Notes on Alice"
- `"Memory Book {{date}}"` → "Memory Book 1/15/2025"

### 4.6 Per-Chat Settings

Some settings can be overridden per-chat, stored in chat metadata.

**Chat Metadata Structure** (from `index.js`):

```javascript
function getChatMetadata() {
    const context = getContext();
    const chatId = context.chatId;
    
    if (!context.chat_metadata) {
        context.chat_metadata = {};
    }
    
    // Initialize MemoryBooks metadata if not present
    if (!context.chat_metadata.stmemorybooks) {
        context.chat_metadata.stmemorybooks = {
            baseline: 0,
            autoSummaryEnabled: null,  // null = use global setting
            profileId: null,            // null = use default profile
            boundLorebookId: null       // Which lorebook is bound to this chat
        };
    }
    
    return context.chat_metadata.stmemorybooks;
}
```

**Per-Chat Overrides**:

- **Auto-Summary Enable/Disable**: Can disable auto-summary for specific chats
- **Custom Profile**: Use different profile for different characters/scenarios
- **Baseline**: Independent message counting per chat
- **Bound Lorebook**: Which lorebook receives entries for this chat

### 4.7 Entry-Level Settings

Individual lorebook entries can have custom settings.

**Entry Settings** (from `addlore.js`):

```javascript
function applyLorebookEntrySettings(entry, customSettings = {}) {
    const globalDefaults = extension_settings.stmemorybooks.defaultLorebookSettings;
    
    // Merge settings priority: customSettings > globalDefaults > hardcoded defaults
    entry.position = customSettings.position || globalDefaults.position || 'after_char';
    entry.order = customSettings.order ?? globalDefaults.order ?? 100;
    entry.depth = customSettings.depth ?? globalDefaults.depth ?? 4;
    
    // Advanced settings
    entry.selectiveLogic = customSettings.selectiveLogic ?? 0; // 0 = AND, 1 = OR
    entry.constant = customSettings.constant ?? false;
    entry.probability = customSettings.probability ?? 100;
    
    // Token budget (if supported by SillyTavern version)
    if (customSettings.tokenBudget !== undefined) {
        entry.extensions = entry.extensions || {};
        entry.extensions.token_budget = customSettings.tokenBudget;
    }
    
    return entry;
}
```

**Settable Properties**:

- **position**: Where entry appears in context (`before_char`, `after_char`, `at_depth`)
- **order**: Priority order (lower = higher priority)
- **depth**: Scan depth (how many lines back to search)
- **selectiveLogic**: AND (all keywords) vs OR (any keyword)
- **constant**: Always active (ignores keywords)
- **probability**: % chance to activate when triggered
- **tokenBudget**: Max tokens for this entry

### 4.8 Settings Persistence

**Save Mechanism** (from `index.js`):

```javascript
// Debounced save to prevent excessive writes
let saveSettingsTimeout = null;

function saveSettingsDebounced() {
    if (saveSettingsTimeout) {
        clearTimeout(saveSettingsTimeout);
    }
    
    saveSettingsTimeout = setTimeout(() => {
        saveSettingsImmediate();
    }, 500); // 500ms debounce
}

function saveSettingsImmediate() {
    // SillyTavern's extension settings API
    saveSettings();
    console.log("[MemoryBooks] Settings saved");
}
```

Settings are saved to:
- `data/<user>/settings.json` (SillyTavern's settings file)
- Chat metadata saved to: `data/<user>/chats/<chat_id>.jsonl` (per-chat state)

---

## 5. Integration with World Info

### 5.1 SillyTavern World Info System

SillyTavern's world info (also called "lorebooks") is a system for injecting contextual information into AI prompts based on keyword matching. MemoryBooks creates entries that are fully compatible with this system.

**World Info Concepts**:

- **Lorebook**: Container for world info entries
- **Entry**: Single piece of world info with keywords and content
- **Keywords**: Terms that trigger entry activation
- **Activation**: When keywords appear in context, entry content is injected
- **Scan Depth**: How far back in conversation to search for keywords

### 5.2 Lorebook Data Structure

**SillyTavern Lorebook Format** (from world info documentation):

```javascript
const lorebookStructure = {
    name: "Lorebook Name",
    description: "Optional description",
    entries: [
        {
            uid: 12345,  // Unique ID (auto-generated)
            key: ["keyword1", "keyword2"],  // Trigger keywords
            keysecondary: [],  // Optional secondary keywords
            comment: "Entry title/comment",  // Human-readable label
            content: "The actual world info content to inject",
            constant: false,  // Always active?
            selective: true,  // Use keyword matching?
            order: 100,  // Priority (lower = higher)
            position: "after_char",  // Injection position
            depth: 4,  // Scan depth
            probability: 100,  // Activation chance (%)
            enabled: true,  // Entry enabled?
            
            // Optional extended fields
            extensions: {
                // Extension-specific metadata
            }
        }
    ]
};
```

### 5.3 MemoryBooks Entry Creation

**Entry Creation Process** (from `addlore.js`):

```javascript
/**
 * Add memory to lorebook as a world info entry
 */
async function addMemoryToLorebook(memory, metadata) {
    const settings = extension_settings.stmemorybooks;
    const chatMetadata = getChatMetadata();
    
    // 1. Get or create lorebook
    let lorebookId = chatMetadata.boundLorebookId;
    
    if (!lorebookId && settings.autoCreateLorebook) {
        lorebookId = await autoCreateLorebook();
        chatMetadata.boundLorebookId = lorebookId;
        saveChatMetadata();
    }
    
    if (!lorebookId) {
        throw new Error("No lorebook available and auto-create is disabled");
    }
    
    // 2. Load lorebook
    const lorebook = await loadLorebook(lorebookId);
    
    // 3. Create entry
    const entry = {
        uid: generateUniqueEntryId(),
        key: memory.keywords,  // Array of keywords
        keysecondary: [],
        comment: memory.title,  // Title as comment
        content: memory.content,  // Summary as content
        constant: false,
        selective: true,  // Enable keyword matching
        order: settings.defaultLorebookSettings.order,
        position: settings.defaultLorebookSettings.position,
        depth: settings.defaultLorebookSettings.depth,
        probability: 100,
        enabled: true,
        caseSensitive: false,
        
        // MemoryBooks metadata
        extensions: {
            stmemorybooks: {
                isMemory: true,  // Flag to identify MemoryBooks entries
                profileUsed: metadata.profileUsed,
                sceneRange: metadata.sceneRange,
                timestamp: metadata.timestamp,
                isAutomatic: metadata.isAutomatic,
                tokenUsage: metadata.tokenUsage
            }
        }
    };
    
    // 4. Normalize entry (handle different SillyTavern versions)
    normalizeLorebookEntry(entry);
    
    // 5. Add to lorebook
    lorebook.entries.push(entry);
    
    // 6. Save lorebook
    await saveLorebook(lorebookId, lorebook);
    
    // 7. Notify user
    if (settings.showNotifications) {
        toastr.success(`Memory added: ${memory.title}`);
    }
    
    console.log(`[MemoryBooks] Added entry ${entry.uid} to lorebook ${lorebookId}`);
    
    return entry.uid;
}
```

### 5.4 Entry Settings Normalization

**Handling Version Differences** (from `addlore.js`):

```javascript
/**
 * Normalize entry to handle different SillyTavern versions
 * Ensures compatibility across different world info implementations
 */
function normalizeLorebookEntry(entry) {
    // Ensure 'key' is array (older versions used string)
    if (typeof entry.key === 'string') {
        entry.key = entry.key.split(',').map(k => k.trim()).filter(k => k);
    }
    
    // Add 'keys' alias for compatibility
    entry.keys = entry.key;
    
    // Ensure 'position' is valid
    const validPositions = ['before_char', 'after_char', 'at_depth', 'top', 'bottom'];
    if (!validPositions.includes(entry.position)) {
        entry.position = 'after_char';
    }
    
    // Constrain 'order' to reasonable range
    entry.order = Math.max(0, Math.min(1000, entry.order));
    
    // Constrain 'depth' to 0-10
    entry.depth = Math.max(0, Math.min(10, entry.depth));
    
    // Ensure probability is 0-100
    entry.probability = Math.max(0, Math.min(100, entry.probability));
    
    // Initialize extensions if missing
    if (!entry.extensions) {
        entry.extensions = {};
    }
    
    return entry;
}
```

### 5.5 Automatic Lorebook Creation

**Auto-Creation Logic** (from `autocreate.js`):

```javascript
/**
 * Automatically create and bind a lorebook for the current chat
 */
async function autoCreateLorebook() {
    const settings = extension_settings.stmemorybooks;
    const chatMetadata = getChatMetadata();
    
    // Generate name from template
    const lorebookName = generateLorebookName(settings.lorebookNamingTemplate);
    
    // Create lorebook structure
    const lorebook = {
        name: lorebookName,
        description: `Automatically created by MemoryBooks for this chat. Contains AI-generated memory entries.`,
        entries: [],
        extensions: {
            stmemorybooks: {
                autoCreated: true,
                createdAt: Date.now()
            }
        }
    };
    
    // Save lorebook
    const lorebookId = await saveNewLorebook(lorebook);
    
    // Bind to chat if auto-bind enabled
    if (settings.autoBindLorebook) {
        chatMetadata.boundLorebookId = lorebookId;
        saveChatMetadata();
        
        // Also bind via SillyTavern's world info system
        await bindLorebookToChat(lorebookId);
    }
    
    console.log(`[MemoryBooks] Created lorebook: ${lorebookName} (ID: ${lorebookId})`);
    
    return lorebookId;
}

/**
 * Bind lorebook to current chat in SillyTavern
 */
async function bindLorebookToChat(lorebookId) {
    const context = getContext();
    
    // Add to chat's lorebook list
    if (!context.chat_metadata.world_info) {
        context.chat_metadata.world_info = [];
    }
    
    if (!context.chat_metadata.world_info.includes(lorebookId)) {
        context.chat_metadata.world_info.push(lorebookId);
        saveChatMetadata();
    }
    
    // Refresh world info in SillyTavern
    if (typeof refreshWorldInfo === 'function') {
        refreshWorldInfo();
    }
}
```

### 5.6 Entry Management

**Finding MemoryBooks Entries** (from `index.js`):

```javascript
/**
 * Get all MemoryBooks-created entries from a lorebook
 */
function getMemoryEntriesFromLorebook(lorebookId) {
    const lorebook = loadLorebook(lorebookId);
    
    return lorebook.entries.filter(entry => {
        return entry.extensions?.stmemorybooks?.isMemory === true;
    });
}

/**
 * Count memories in current chat's lorebook
 */
function getMemoryCount() {
    const chatMetadata = getChatMetadata();
    const lorebookId = chatMetadata.boundLorebookId;
    
    if (!lorebookId) return 0;
    
    const memories = getMemoryEntriesFromLorebook(lorebookId);
    return memories.length;
}
```

**Updating Existing Entries** (from `addlore.js`):

```javascript
/**
 * Update existing memory entry
 * Used by consolidation system and manual edits
 */
async function updateMemoryEntry(entryUid, updates) {
    const lorebook = await findLorebookWithEntry(entryUid);
    if (!lorebook) {
        throw new Error(`Entry ${entryUid} not found`);
    }
    
    const entry = lorebook.entries.find(e => e.uid === entryUid);
    
    // Apply updates
    if (updates.title) entry.comment = updates.title;
    if (updates.content) entry.content = updates.content;
    if (updates.keywords) entry.key = updates.keywords;
    
    // Update metadata
    if (entry.extensions?.stmemorybooks) {
        entry.extensions.stmemorybooks.lastModified = Date.now();
    }
    
    await saveLorebook(lorebook.id, lorebook);
}
```

**Deleting Entries** (from `addlore.js`):

```javascript
/**
 * Delete memory entry from lorebook
 */
async function deleteMemoryEntry(entryUid) {
    const lorebook = await findLorebookWithEntry(entryUid);
    if (!lorebook) {
        console.warn(`[MemoryBooks] Entry ${entryUid} not found`);
        return;
    }
    
    // Remove entry
    lorebook.entries = lorebook.entries.filter(e => e.uid !== entryUid);
    
    await saveLorebook(lorebook.id, lorebook);
    
    console.log(`[MemoryBooks] Deleted entry ${entryUid}`);
}
```

### 5.7 Keyword Matching & Activation

MemoryBooks-created entries use SillyTavern's standard keyword matching system. No special handling is required - entries activate based on keywords appearing in the context.

**How Activation Works**:

1. **Scanning**: SillyTavern scans the last N messages (based on `depth` setting)
2. **Keyword Matching**: Checks if any entry keywords appear in scanned text
3. **Activation**: If match found, entry content is injected into prompt
4. **Position**: Content placed according to `position` setting
5. **Priority**: Multiple activated entries ordered by `order` value (lower first)

**Example Activation**:

```
Entry Keywords: ["market", "merchant", "haggling"]
Scan Depth: 4 (last 4 messages)

Recent Messages:
- Message 1: "I walk into the bustling market square."
- Message 2: "A merchant calls out, trying to sell apples."
- Message 3: "I approach the fruit stand."
- Message 4: "The merchant grins and starts haggling."

Result: Entry ACTIVATES (keywords "market", "merchant", "haggling" found)
Entry content is injected into AI prompt before next generation.
```

### 5.8 ConstVectMode & Constant Entries

**Constant Entries**: Entries with `constant: true` are ALWAYS active, ignoring keywords.

MemoryBooks can create constant entries for:
- Character core facts that should always be present
- Critical world information
- Recent high-priority memories

**Setting Constant Mode** (from `addlore.js`):

```javascript
function makeEntryConstant(entry, isConstant) {
    entry.constant = isConstant;
    
    // When constant, disable selective (no keyword matching)
    if (isConstant) {
        entry.selective = false;
    }
    
    return entry;
}
```

**ConstVectMode** (Vector Database Integration):

Some SillyTavern versions support vector database integration for semantic matching instead of keyword matching. MemoryBooks entries are compatible with this system through the `extensions` field.

### 5.9 Multi-Lorebook Management

**Multiple Lorebooks**:

SillyTavern supports multiple lorebooks active simultaneously. MemoryBooks can:
- Create separate lorebooks for different characters
- Maintain character-specific vs. chat-specific lorebooks
- Organize memories by topic/category

**Lorebook Selection Strategies**:

1. **One Per Chat** (default): Auto-create one lorebook per chat
2. **One Per Character**: Create character-specific lorebooks, reuse across chats
3. **Manual**: User selects target lorebook for each memory

**Example: Character-Specific Lorebooks** (from `autocreate.js`):

```javascript
function getOrCreateCharacterLorebook(characterName) {
    const lorebookName = `${characterName} - Persistent Memories`;
    
    // Check if lorebook already exists
    const existingLorebook = findLorebookByName(lorebookName);
    if (existingLorebook) {
        return existingLorebook.id;
    }
    
    // Create new character lorebook
    return autoCreateLorebook({
        nameTemplate: lorebookName,
        description: `Persistent memory lorebook for ${characterName}`
    });
}
```

---

## 6. Technical Implementation

### 6.1 File Structure

**Extension Directory Layout**:

```
SillyTavern/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/
├── index.js                 # Main entry point (~7000 lines)
├── manifest.json            # Extension metadata
├── README.md               # User documentation
├── USER_GUIDE.md           # Comprehensive user guide
├── USER_GUIDE_<LANG>.md    # Localized guides (DE, ES, FR, JP, KO, RU, ZH-CN, ZH-TW, ID, MS)
├── CHANGELOG.md            # Version history
│
├── style.css               # Extension-specific styles
│
├── templates.js            # Handlebars templates for UI
├── locales.js              # Internationalization strings
├── constants.js            # Configuration constants
│
├── stmemory.js             # Memory generation & LLM communication
├── addlore.js              # Lorebook entry creation & management
├── chatcompile.js          # Chat message compilation into scenes
├── utils.js                # Utility functions & built-in prompts
│
├── autosummary.js          # Automatic memory creation triggers
├── autocreate.js           # Automatic lorebook creation & binding
│
├── arcanalysis.js          # Summary consolidation system
├── sidePrompts.js          # Side prompt system
├── profileManager.js       # Profile management
├── sceneManager.js         # Scene marker management
│
└── confirmationPopup.js    # Confirmation dialog utilities
```

### 6.2 Core File: `index.js`

**Main Entry Point** (~7000 lines):

```javascript
// ===== EXTENSION METADATA =====
const extensionName = "SillyTavern-MemoryBooks";
const extensionVersion = "1.5.0";

// ===== INITIALIZATION =====
jQuery(async () => {
    // Wait for SillyTavern to be ready
    await waitForSillyTavernInit();
    
    // Initialize extension
    initializeMemoryBooksExtension();
});

async function initializeMemoryBooksExtension() {
    console.log(`[MemoryBooks] Initializing ${extensionVersion}`);
    
    // 1. Load settings
    initializeSettings();
    
    // 2. Register event listeners
    setupEventListeners();
    
    // 3. Register slash commands
    registerSlashCommands();
    
    // 4. Inject UI elements
    injectChevronButtons();
    
    // 5. Load profiles
    loadProfiles();
    
    // 6. Check for updates
    checkForUpdates();
    
    console.log("[MemoryBooks] Initialization complete");
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
    // Auto-summary triggers
    eventSource.on(event_types.MESSAGE_RECEIVED, handleAutoSummaryMessageReceived);
    eventSource.on(event_types.GROUP_WRAPPER_FINISHED, handleAutoSummaryGroupFinished);
    
    // Chat management
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.CHAT_DELETED, onChatDeleted);
    
    // Settings
    eventSource.on(event_types.SETTINGS_LOADED, onSettingsLoaded);
    eventSource.on(event_types.SETTINGS_UPDATED, onSettingsUpdated);
    
    // UI events
    $(document).on('click', '.stmb-chevron-start', onChevronStartClick);
    $(document).on('click', '.stmb-chevron-end', onChevronEndClick);
}

// ===== SLASH COMMANDS =====
function registerSlashCommands() {
    registerSlashCommand('stmb-create', createMemoryCommand, [], 
        'Create memory from current scene', true, true);
    
    registerSlashCommand('stmb-settings', showSettingsPopup, [], 
        'Open MemoryBooks settings', true, true);
    
    registerSlashCommand('stmb-analyze', runArcAnalysis, [], 
        'Run arc analysis consolidation', true, true);
    
    registerSlashCommand('stmb-baseline', resetBaseline, ['reset'], 
        'Reset auto-summary baseline', true, true);
}

// ===== MAIN MEMORY CREATION WORKFLOW =====
async function executeMemoryGeneration(options = {}) {
    const {
        sceneStart,
        sceneEnd,
        profileId = null,
        isAutomatic = false
    } = options;
    
    try {
        // Show progress indicator
        showGenerationProgress();
        
        // 1. Validate scene range
        if (sceneStart >= sceneEnd) {
            throw new Error("Invalid scene range");
        }
        
        // 2. Compile scene
        const scene = compileScene(sceneStart, sceneEnd);
        
        // 3. Check lorebook
        await ensureLorebookExists();
        
        // 4. Generate memory via LLM
        const memory = await createMemory({
            scene: scene,
            profileId: profileId,
            isAutomatic: isAutomatic
        });
        
        // 5. Add to lorebook
        const entryId = await addMemoryToLorebook(memory, {
            sceneRange: { start: sceneStart, end: sceneEnd },
            profileUsed: profileId,
            timestamp: Date.now(),
            isAutomatic: isAutomatic
        });
        
        // 6. Post-processing
        if (isAutomatic) {
            // Update baseline
            updateAutoSummaryBaseline(sceneEnd + 1);
            
            // Auto-hide messages if enabled
            if (extension_settings.stmemorybooks.autoHideMessages) {
                hideMessagesInRange(sceneStart, sceneEnd);
            }
        }
        
        // 7. Run side prompts if enabled
        if (extension_settings.stmemorybooks.sidePromptsEnabled) {
            await runSidePrompts(scene);
        }
        
        // 8. Check consolidation threshold
        const memoryCount = getMemoryCount();
        if (memoryCount >= extension_settings.stmemorybooks.memoryCountThreshold) {
            if (extension_settings.stmemorybooks.arcAnalysisEnabled) {
                await runArcAnalysis();
            }
        }
        
        // 9. Clear scene markers
        clearSceneMarkers();
        
        // 10. Show success notification
        if (extension_settings.stmemorybooks.showNotifications) {
            toastr.success(`Memory created: ${memory.title}`);
        }
        
        console.log(`[MemoryBooks] Memory generation complete (entry: ${entryId})`);
        
        return entryId;
        
    } catch (error) {
        console.error("[MemoryBooks] Memory generation failed:", error);
        toastr.error(`Failed to create memory: ${error.message}`);
        throw error;
        
    } finally {
        hideGenerationProgress();
    }
}

// ===== SETTINGS MANAGEMENT =====
function showSettingsPopup() {
    const settings = extension_settings.stmemorybooks;
    
    // Render template
    const html = Handlebars.templates['stmemory-settings'](settings);
    
    // Show popup
    const popup = $(html);
    $('body').append(popup);
    
    // Setup event handlers
    popup.find('.save-settings').on('click', saveSettingsFromPopup);
    popup.find('.close-popup').on('click', () => popup.remove());
    
    // Tab switching
    popup.find('.settings-tab-button').on('click', function() {
        const tab = $(this).data('tab');
        switchSettingsTab(tab);
    });
}

// ===== UTILITY FUNCTIONS =====
function getCurrentChatId() {
    const context = getContext();
    return context.chatId;
}

function getCurrentMessageIndex() {
    const context = getContext();
    return context.chat.length - 1;
}

function getChatMetadata() {
    const context = getContext();
    return context.chat_metadata?.stmemorybooks || {};
}

function saveChatMetadata() {
    const context = getContext();
    saveMetadata();
}
```

### 6.3 Memory Generation: `stmemory.js`

**Key Functions**:

```javascript
/**
 * Create memory from scene using configured LLM
 */
async function createMemory(options) {
    const { scene, profileId, isAutomatic } = options;
    
    // Get profile configuration
    const profile = getProfile(profileId);
    const prompt = buildPrompt(scene, profile);
    
    // Generate via LLM
    const response = await generateMemoryWithAI(prompt, profile);
    
    // Parse and validate
    const memory = parseAIJsonResponse(response.text);
    validateMemoryStructure(memory);
    
    return {
        ...memory,
        tokenUsage: response.tokenUsage
    };
}

/**
 * Build prompt from scene and profile configuration
 */
function buildPrompt(scene, profile) {
    const settings = extension_settings.stmemorybooks;
    
    // Get prompt template
    let template;
    if (profile.promptPreset === 'custom') {
        template = profile.customPrompt;
    } else {
        const presets = getBuiltInPresetPrompts();
        template = presets[profile.promptPreset]?.systemPrompt || presets['summary'].systemPrompt;
    }
    
    // Replace {{scene}} placeholder
    const prompt = template.replace(/\{\{scene\}\}/g, scene.text);
    
    return prompt;
}

/**
 * Send request to LLM and get response
 */
async function generateMemoryWithAI(prompt, profile) {
    const apiInfo = getCurrentApiInfo();
    
    // Build request based on API type
    const requestBody = buildRequestBody(prompt, profile, apiInfo);
    
    // Send to SillyTavern's generate endpoint
    const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    return {
        text: extractResponseText(data, apiInfo.type),
        tokenUsage: extractTokenUsage(data)
    };
}

/**
 * Build request body based on API type
 */
function buildRequestBody(prompt, profile, apiInfo) {
    const baseConfig = {
        temperature: profile.temperature || 0.7,
        max_tokens: profile.maxTokens || 500
    };
    
    if (apiInfo.type === 'openai' || apiInfo.type === 'claude') {
        // Chat completion format
        return {
            model: profile.model || apiInfo.model,
            messages: [
                { role: "system", content: "You are a memory extraction assistant." },
                { role: "user", content: prompt }
            ],
            ...baseConfig,
            response_format: { type: "json_object" } // Request JSON mode
        };
    } else {
        // Text completion format
        return {
            prompt: prompt,
            ...baseConfig
        };
    }
}
```

### 6.4 Lorebook Operations: `addlore.js`

**Key Functions**:

```javascript
/**
 * Add memory to lorebook as world info entry
 */
async function addMemoryToLorebook(memory, metadata) {
    // Get active lorebook
    const lorebookId = await getActiveLorebookId();
    const lorebook = await loadLorebook(lorebookId);
    
    // Create entry
    const entry = createLorebookEntry(memory, metadata);
    
    // Add to lorebook
    lorebook.entries.push(entry);
    await saveLorebook(lorebookId, lorebook);
    
    return entry.uid;
}

/**
 * Create lorebook entry from memory
 */
function createLorebookEntry(memory, metadata) {
    const settings = extension_settings.stmemorybooks;
    
    return {
        uid: generateUniqueEntryId(),
        key: memory.keywords,
        keysecondary: [],
        comment: memory.title,
        content: memory.content,
        constant: false,
        selective: true,
        order: settings.defaultLorebookSettings.order,
        position: settings.defaultLorebookSettings.position,
        depth: settings.defaultLorebookSettings.depth,
        probability: 100,
        enabled: true,
        caseSensitive: false,
        extensions: {
            stmemorybooks: {
                isMemory: true,
                profileUsed: metadata.profileUsed,
                sceneRange: metadata.sceneRange,
                timestamp: metadata.timestamp,
                isAutomatic: metadata.isAutomatic,
                tokenUsage: metadata.tokenUsage
            }
        }
    };
}

/**
 * Get or create active lorebook ID
 */
async function getActiveLorebookId() {
    const chatMetadata = getChatMetadata();
    let lorebookId = chatMetadata.boundLorebookId;
    
    if (!lorebookId) {
        const settings = extension_settings.stmemorybooks;
        if (settings.autoCreateLorebook) {
            lorebookId = await autoCreateLorebook();
            chatMetadata.boundLorebookId = lorebookId;
            saveChatMetadata();
        } else {
            throw new Error("No lorebook bound and auto-create disabled");
        }
    }
    
    return lorebookId;
}

/**
 * Load lorebook by ID
 */
async function loadLorebook(lorebookId) {
    const response = await fetch(`/api/worldinfo/get?lorebookId=${lorebookId}`);
    if (!response.ok) {
        throw new Error(`Failed to load lorebook: ${response.status}`);
    }
    return await response.json();
}

/**
 * Save lorebook
 */
async function saveLorebook(lorebookId, lorebook) {
    const response = await fetch('/api/worldinfo/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lorebookId, lorebook })
    });
    
    if (!response.ok) {
        throw new Error(`Failed to save lorebook: ${response.status}`);
    }
}
```

### 6.5 Scene Compilation: `chatcompile.js`

```javascript
/**
 * Compile chat messages into scene text
 */
function compileScene(startIndex, endIndex, options = {}) {
    const context = getContext();
    const chat = context.chat;
    const settings = extension_settings.stmemorybooks;
    
    let compiledText = "";
    let messageCount = 0;
    let tokenCount = 0;
    
    for (let i = startIndex; i <= endIndex; i++) {
        const message = chat[i];
        
        // Skip system/hidden messages unless includeHiddenMessages enabled
        if (message.is_system || message.extra?.isHidden) {
            if (!settings.includeHiddenMessages) {
                continue;
            }
        }
        
        // Determine speaker
        const speaker = message.is_user 
            ? (message.name || context.name1 || "{{user}}")
            : (message.name || context.name2 || "{{char}}");
        
        // Format message
        const messageText = `${speaker}: ${message.mes}\n\n`;
        compiledText += messageText;
        messageCount++;
        
        // Estimate tokens
        tokenCount += estimateTokens(message.mes);
    }
    
    return {
        text: compiledText,
        messageCount: messageCount,
        tokenCount: tokenCount,
        sceneRange: { start: startIndex, end: endIndex }
    };
}

/**
 * Get scene statistics without full compilation
 */
function getSceneStats(startIndex, endIndex) {
    const context = getContext();
    const chat = context.chat;
    
    let messageCount = 0;
    let tokenCount = 0;
    
    for (let i = startIndex; i <= endIndex; i++) {
        const message = chat[i];
        if (!message.is_system && !message.extra?.isHidden) {
            messageCount++;
            tokenCount += estimateTokens(message.mes);
        }
    }
    
    return { messageCount, tokenCount };
}
```

### 6.6 Side Prompts System: `sidePrompts.js`

Side prompts allow running additional AI tasks alongside memory creation.

**Side Prompt Structure**:

```javascript
const sidePromptSchema = {
    name: "Side Prompt Name",
    enabled: true,
    template: "Analyze this scene and extract {{tracker}} information:\n\n{{scene}}",
    profileId: "default",
    outputFormat: "text", // "text" or "json"
    saveToTracker: true,  // Save output to tracker variable
    trackerName: "location_history",
    triggerMode: "automatic" // "automatic", "manual", or "consolidation"
};
```

**Side Prompt Execution** (from `sidePrompts.js`):

```javascript
async function runSidePrompts(scene) {
    const settings = extension_settings.stmemorybooks;
    if (!settings.sidePromptsEnabled) return;
    
    const sidePrompts = settings.sidePrompts.filter(sp => sp.enabled);
    
    for (const sidePrompt of sidePrompts) {
        if (sidePrompt.triggerMode === 'automatic') {
            await executeSidePrompt(sidePrompt, scene);
        }
    }
}

async function executeSidePrompt(sidePrompt, scene) {
    // Prepare prompt with runtime macros
    const prompt = prepareSidePromptTemplate(sidePrompt.template, scene);
    
    // Execute via LLM
    const response = await generateMemoryWithAI(prompt, getProfile(sidePrompt.profileId));
    
    // Process output
    if (sidePrompt.saveToTracker) {
        updateTracker(sidePrompt.trackerName, response.text);
    }
    
    console.log(`[MemoryBooks] Side prompt executed: ${sidePrompt.name}`);
}

function prepareSidePromptTemplate(template, scene) {
    const context = getContext();
    
    return template
        .replace(/\{\{scene\}\}/g, scene.text)
        .replace(/\{\{char\}\}/g, context.name2 || "{{char}}")
        .replace(/\{\{user\}\}/g, context.name1 || "{{user}}")
        .replace(/\{\{tracker:([^}]+)\}\}/g, (match, trackerName) => {
            return getTrackerValue(trackerName) || "";
        });
}
```

### 6.7 Arc Analysis (Consolidation): `arcanalysis.js`

**Multi-Tier Consolidation System**:

```javascript
/**
 * Run summary consolidation when memory count exceeds threshold
 * Creates hierarchical summaries of existing memories
 */
async function runArcAnalysis() {
    const settings = extension_settings.stmemorybooks;
    const lorebookId = await getActiveLorebookId();
    const lorebook = await loadLorebook(lorebookId);
    
    // Get all memory entries
    const memories = lorebook.entries.filter(e => e.extensions?.stmemorybooks?.isMemory);
    
    if (memories.length < settings.memoryCountThreshold) {
        console.log("[MemoryBooks] Memory count below threshold, skipping arc analysis");
        return;
    }
    
    console.log(`[MemoryBooks] Starting arc analysis (${memories.length} memories)`);
    
    // Group memories into tiers
    const tiers = groupMemoriesIntoTiers(memories, settings.arcAnalysisTiers, settings.arcAnalysisInterval);
    
    // Process each tier
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
        const tier = tiers[tierIndex];
        const consolidatedMemory = await consolidateTier(tier, tierIndex);
        
        // Create consolidated entry
        await addMemoryToLorebook(consolidatedMemory, {
            sceneRange: { start: tier[0].sceneStart, end: tier[tier.length - 1].sceneEnd },
            profileUsed: settings.defaultProfileId,
            timestamp: Date.now(),
            isAutomatic: true,
            isConsolidated: true,
            tierLevel: tierIndex,
            sourceMemoryCount: tier.length
        });
        
        // Optionally disable source memories
        if (settings.arcAnalysisDisableSourceMemories) {
            for (const memory of tier) {
                memory.enabled = false;
            }
        }
    }
    
    await saveLorebook(lorebookId, lorebook);
    console.log("[MemoryBooks] Arc analysis complete");
}

/**
 * Group memories into tiers for hierarchical summarization
 */
function groupMemoriesIntoTiers(memories, tierCount, intervalPerTier) {
    const tiers = [];
    
    for (let i = 0; i < tierCount; i++) {
        const startIdx = i * intervalPerTier;
        const endIdx = Math.min(startIdx + intervalPerTier, memories.length);
        
        if (startIdx >= memories.length) break;
        
        tiers.push(memories.slice(startIdx, endIdx));
    }
    
    return tiers;
}

/**
 * Consolidate a tier of memories into a single summary
 */
async function consolidateTier(tierMemories, tierIndex) {
    // Compile tier memories into text
    const tierText = tierMemories.map(m => {
        return `**${m.comment}**\n${m.content}\n`;
    }).join('\n');
    
    // Build consolidation prompt
    const prompt = `Summarize the following ${tierMemories.length} memory entries into a single comprehensive summary.

Entries:
${tierText}

Create a JSON response with:
- title: A descriptive title for this consolidated summary
- content: A comprehensive summary combining all entries
- keywords: 20-40 keywords covering all entries

JSON Output:`;
    
    // Generate consolidated memory
    const profile = getProfile(extension_settings.stmemorybooks.defaultProfileId);
    const response = await generateMemoryWithAI(prompt, profile);
    const consolidatedMemory = parseAIJsonResponse(response.text);
    
    // Generate additional keywords from all source memories
    const allKeywords = new Set();
    tierMemories.forEach(m => {
        if (Array.isArray(m.key)) {
            m.key.forEach(k => allKeywords.add(k));
        }
    });
    
    // Merge with LLM-generated keywords
    consolidatedMemory.keywords = [
        ...new Set([...consolidatedMemory.keywords, ...Array.from(allKeywords)])
    ].slice(0, 50); // Limit to 50 total
    
    return consolidatedMemory;
}
```

### 6.8 Event Hooks & Integration Points

**SillyTavern Event Types Used**:

```javascript
// From SillyTavern's event system
const event_types = {
    MESSAGE_RECEIVED: 'message_received',
    GROUP_WRAPPER_FINISHED: 'group_wrapper_finished',
    CHAT_CHANGED: 'chat_changed',
    CHAT_DELETED: 'chat_deleted',
    SETTINGS_LOADED: 'settings_loaded',
    SETTINGS_UPDATED: 'settings_updated',
    WORLDINFO_CREATED: 'worldinfo_created',
    WORLDINFO_UPDATED: 'worldinfo_updated'
};
```

**Event Handler Examples**:

```javascript
// Handle message received (for auto-summary)
function handleAutoSummaryMessageReceived() {
    const chatId = getCurrentChatId();
    if (!chatId) return;
    
    const chatMetadata = getChatMetadata();
    if (chatMetadata.autoSummaryEnabled === false) return;
    
    checkAutoSummaryTrigger(chatId, false);
}

// Handle chat changed (reset context)
function onChatChanged() {
    // Clear scene markers
    clearSceneMarkers();
    
    // Reinitialize baseline
    const chatId = getCurrentChatId();
    initializeAutoSummaryBaseline(chatId);
    
    // Update chevron buttons
    updateAllButtonStates();
}

// Handle settings loaded (merge with defaults)
function onSettingsLoaded() {
    const currentSettings = extension_settings.stmemorybooks;
    const merged = Object.assign({}, defaultSettings, currentSettings);
    extension_settings.stmemorybooks = merged;
}
```

### 6.9 API Endpoints Used

MemoryBooks interacts with SillyTavern's backend API:

**Endpoints**:

- `POST /api/generate` - Send prompts to LLM
- `GET /api/worldinfo/get?lorebookId=<id>` - Load lorebook
- `POST /api/worldinfo/save` - Save lorebook
- `GET /api/worldinfo/list` - List available lorebooks
- `POST /api/worldinfo/create` - Create new lorebook
- `POST /api/settings/get` - Load extension settings
- `POST /api/settings/save` - Save extension settings
- `GET /api/chats/get?chatId=<id>` - Load chat history
- `POST /api/chats/save` - Save chat metadata

### 6.10 Performance Considerations

**Token Limits**:

```javascript
// Prevent scenes from exceeding model context limits
function validateSceneSize(scene) {
    const settings = extension_settings.stmemorybooks;
    
    if (scene.tokenCount > settings.maxSceneTokens) {
        console.warn(`[MemoryBooks] Scene exceeds max tokens (${scene.tokenCount} > ${settings.maxSceneTokens})`);
        
        // Option: Truncate scene
        // Option: Reject and notify user
        throw new Error(`Scene too large: ${scene.tokenCount} tokens`);
    }
    
    return true;
}
```

**Rate Limiting**:

```javascript
// Debounce rapid auto-summary triggers
let lastAutoSummaryTime = 0;
const AUTO_SUMMARY_COOLDOWN = 5000; // 5 seconds

function checkAutoSummaryTrigger(chatId, isGroupFinished) {
    const now = Date.now();
    if (now - lastAutoSummaryTime < AUTO_SUMMARY_COOLDOWN) {
        console.log("[MemoryBooks] Auto-summary on cooldown");
        return;
    }
    
    // ... trigger logic ...
    
    lastAutoSummaryTime = now;
}
```

**Caching**:

```javascript
// Cache compiled scenes to avoid recompilation
const sceneCache = new Map();

function getCachedScene(startIndex, endIndex) {
    const key = `${startIndex}-${endIndex}`;
    
    if (!sceneCache.has(key)) {
        const scene = compileScene(startIndex, endIndex);
        sceneCache.set(key, scene);
        
        // Clear cache after 5 minutes
        setTimeout(() => sceneCache.delete(key), 300000);
    }
    
    return sceneCache.get(key);
}
```

---

## 7. Application to Caretaker Agent Scenarios

### 7.1 Relevance to Multi-User Caretaker Systems

The SillyTavern-MemoryBooks extension provides valuable patterns and techniques applicable to caretaker agent systems that manage context and memories for multiple users.

**Key Parallels**:

1. **Automated Context Extraction**: Both systems need to automatically identify and extract important information from ongoing conversations
2. **Interval-Based Processing**: Trigger-based systems (every N messages) prevent information overload
3. **Structured Memory Format**: JSON-based memory entries with titles, content, and keywords enable semantic retrieval
4. **Multi-Participant Support**: Group chat handling translates to multi-user scenarios
5. **Hierarchical Consolidation**: Arc Analysis pattern applies to preventing memory bloat in long-running systems
6. **Profile Management**: Different LLM configurations for different memory types or users

### 7.2 Adaptation Patterns for Caretaker Agents

**Pattern 1: Message-Based Triggering**

MemoryBooks' auto-summary system can be adapted for caretaker agents:

```javascript
// MemoryBooks Pattern
function checkAutoSummaryTrigger(chatId) {
    const messagesSinceBaseline = currentMessageIndex - baseline;
    if (messagesSinceBaseline >= (interval + buffer)) {
        executeMemoryGeneration();
    }
}

// Caretaker Agent Adaptation
function checkContextUpdateTrigger(userId, conversationId) {
    const messagesSinceLastUpdate = getMessageCount(userId, conversationId) - lastUpdateBaseline;
    
    if (messagesSinceLastUpdate >= contextUpdateInterval) {
        // Extract important context from recent messages
        const recentContext = await extractContextFromConversation(userId, conversationId);
        
        // Update user context database
        await updateUserContext(userId, recentContext);
        
        // Update baseline
        lastUpdateBaseline = getMessageCount(userId, conversationId);
    }
}
```

**Pattern 2: Scene Compilation for Context Windows**

The scene compilation pattern is directly applicable to managing context windows:

```javascript
// Adapt scene compilation for context window management
function compileContextWindow(userId, messageLimit = 20) {
    const recentMessages = getRecentMessages(userId, messageLimit);
    
    let compiledContext = "";
    for (const message of recentMessages) {
        compiledContext += `${message.sender}: ${message.content}\n\n`;
    }
    
    // Add relevant world info/memories based on keywords
    const keywords = extractKeywords(compiledContext);
    const relevantMemories = retrieveMemoriesByKeywords(userId, keywords);
    
    return {
        recentConversation: compiledContext,
        relevantContext: relevantMemories,
        tokenCount: estimateTokens(compiledContext + relevantMemories)
    };
}
```

**Pattern 3: Hierarchical Memory Consolidation**

Arc Analysis provides a model for preventing memory bloat in long-running caretaker systems:

```javascript
// Multi-tier memory consolidation for caretaker agents
async function consolidateUserMemories(userId) {
    const allMemories = await getUserMemories(userId);
    
    // Group memories by time period (e.g., weekly, monthly)
    const timePeriods = groupMemoriesByTimePeriod(allMemories);
    
    for (const period of timePeriods) {
        if (period.memories.length >= consolidationThreshold) {
            // Consolidate this period's memories
            const consolidatedMemory = await consolidateMemorySet(period.memories);
            
            // Store consolidated memory with higher priority
            await storeConsolidatedMemory(userId, consolidatedMemory, {
                priority: 'high',
                sourceCount: period.memories.length,
                timePeriod: period.range
            });
            
            // Archive or disable source memories
            await archiveSourceMemories(period.memories);
        }
    }
}
```

### 7.3 Privacy & User Control Adaptations

MemoryBooks' user-controlled intervals and scene selection provide patterns for privacy-conscious caretaker systems:

**Pattern 4: User-Controlled Context Capture**

```javascript
// Allow users to control when context is captured
const userPrivacySettings = {
    autoContextCapture: true,  // User can disable entirely
    captureInterval: 20,        // User configures frequency
    excludeTopics: ['personal', 'private'],  // Topic filtering
    manualApproval: false       // Require approval before capture
};

async function respectPrivacySettings(userId) {
    const settings = await getUserPrivacySettings(userId);
    
    if (!settings.autoContextCapture) {
        console.log(`[Caretaker] Auto-capture disabled for user ${userId}`);
        return;
    }
    
    // Proceed with context capture, respecting settings
    const context = await extractContext(userId);
    
    // Filter excluded topics
    const filteredContext = filterExcludedTopics(context, settings.excludeTopics);
    
    // If manual approval required, queue for review
    if (settings.manualApproval) {
        await queueContextForApproval(userId, filteredContext);
    } else {
        await storeContext(userId, filteredContext);
    }
}
```

**Pattern 5: Transparent Memory Management**

Provide users visibility into what's being remembered:

```javascript
// User-facing memory dashboard (inspired by MemoryBooks UI)
function showUserMemoryDashboard(userId) {
    const memories = getUserMemories(userId);
    
    return {
        totalMemories: memories.length,
        recentMemories: memories.slice(0, 10),
        memoryCategories: categorizeMemories(memories),
        actions: {
            viewAll: () => listAllMemories(userId),
            delete: (memoryId) => deleteMemory(userId, memoryId),
            edit: (memoryId) => editMemory(userId, memoryId),
            export: () => exportMemories(userId)
        }
    };
}
```

### 7.4 JSON-Based Memory Schema

MemoryBooks' JSON format is ideal for caretaker agent memory storage:

**Adapted Memory Schema**:

```json
{
  "userId": "user123",
  "memoryId": "mem_456",
  "timestamp": 1705334400000,
  "source": "conversation",
  "metadata": {
    "conversationId": "conv_789",
    "messageRange": {"start": 45, "end": 55},
    "participantCount": 1,
    "captureMode": "automatic"
  },
  "content": {
    "title": "User prefers dark mode UI",
    "summary": "User explicitly stated preference for dark mode interfaces and mentioned eye strain from bright screens.",
    "keywords": ["ui preference", "dark mode", "accessibility", "eye strain"],
    "priority": "medium",
    "category": "preferences"
  },
  "retrieval": {
    "keywords": ["ui", "interface", "dark mode", "theme", "accessibility"],
    "semanticVector": [0.123, 0.456, ...],  // Optional: embedding for semantic search
    "relevanceScore": 0.85
  },
  "visibility": {
    "userVisible": true,
    "systemInternal": false,
    "sharedWith": []
  }
}
```

### 7.5 Side Prompts for Tracker Management

The side prompts system provides a pattern for maintaining structured trackers alongside free-form memories:

**Adapted for Caretaker Agents**:

```javascript
// Tracker system for structured user information
const trackerDefinitions = {
    preferences: {
        template: "Extract user preferences from this conversation: {{scene}}",
        outputFormat: "json",
        schema: {
            type: "object",
            properties: {
                category: { type: "string" },
                preference: { type: "string" },
                strength: { type: "string", enum: ["weak", "moderate", "strong"] }
            }
        }
    },
    
    goals: {
        template: "Identify any user goals or intentions mentioned: {{scene}}",
        outputFormat: "json",
        schema: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    goal: { type: "string" },
                    timeframe: { type: "string" },
                    status: { type: "string", enum: ["stated", "in-progress", "completed"] }
                }
            }
        }
    },
    
    topics_of_interest: {
        template: "What topics is the user interested in based on this conversation? {{scene}}",
        outputFormat: "json",
        schema: {
            type: "array",
            items: { type: "string" }
        }
    }
};

// Execute tracker updates alongside memory creation
async function updateTrackers(userId, conversationContext) {
    for (const [trackerName, definition] of Object.entries(trackerDefinitions)) {
        const prompt = definition.template.replace('{{scene}}', conversationContext);
        const response = await llmGenerate(prompt);
        
        const parsedData = JSON.parse(response);
        await updateUserTracker(userId, trackerName, parsedData);
    }
}
```

### 7.6 Profile-Based Context Management

Different users or scenarios may require different memory generation strategies:

**Multi-Profile Strategy**:

```javascript
const caretakerProfiles = {
    casual_user: {
        captureInterval: 30,  // Less frequent
        summarizationStyle: "brief",
        keywordCount: 10,
        priority: "low"
    },
    
    power_user: {
        captureInterval: 15,  // More frequent
        summarizationStyle: "detailed",
        keywordCount: 25,
        priority: "high"
    },
    
    privacy_conscious: {
        captureInterval: 50,
        summarizationStyle: "minimal",
        keywordCount: 5,
        priority: "low",
        requireApproval: true
    }
};

function selectProfileForUser(userId) {
    const userTier = getUserTier(userId);
    const userPreferences = getUserPreferences(userId);
    
    if (userPreferences.privacyMode === 'strict') {
        return caretakerProfiles.privacy_conscious;
    } else if (userTier === 'premium') {
        return caretakerProfiles.power_user;
    } else {
        return caretakerProfiles.casual_user;
    }
}
```

### 7.7 Group Context Management

MemoryBooks' group chat support provides patterns for multi-user caretaker scenarios:

**Multi-User Context Tracking**:

```javascript
// Track context in multi-user conversations
async function handleMultiUserConversation(conversationId, participants) {
    const conversationContext = await getConversationContext(conversationId);
    
    // Create shared context entry
    const sharedContext = await extractSharedContext(conversationContext, participants);
    await storeSharedContext(conversationId, sharedContext, {
        participants: participants,
        visibility: 'all_participants'
    });
    
    // Create per-user context entries
    for (const userId of participants) {
        const userSpecificContext = await extractUserSpecificContext(
            conversationContext,
            userId,
            participants
        );
        
        await storeUserContext(userId, userSpecificContext, {
            source: 'multi_user_conversation',
            conversationId: conversationId,
            otherParticipants: participants.filter(p => p !== userId)
        });
    }
}
```

### 7.8 Integration with Manual Context Management

Caretaker agents can combine MemoryBooks-style automation with manual curation:

**Hybrid Approach**:

```javascript
// Combine automatic and manual context management
async function hybridContextManagement(userId) {
    // Automatic: Extract context from recent activity
    const autoContext = await autoExtractContext(userId);
    
    // Store with 'pending_review' flag
    await storePendingContext(userId, autoContext, {
        status: 'pending_review',
        confidence: calculateConfidence(autoContext)
    });
    
    // If confidence is high, auto-approve
    if (autoContext.confidence > 0.85) {
        await approveContext(userId, autoContext.id);
    } else {
        // Otherwise, queue for manual review
        await queueForManualReview(userId, autoContext.id);
    }
}

// Manual context addition (user or admin initiated)
async function addManualContext(userId, contextData) {
    const manualContext = {
        ...contextData,
        source: 'manual',
        timestamp: Date.now(),
        approvalStatus: 'approved',  // Manual entries are pre-approved
        confidence: 1.0
    };
    
    await storeContext(userId, manualContext);
}
```

### 7.9 Context Retrieval for Prompt Construction

Adapt MemoryBooks' keyword-based activation for context retrieval:

**Keyword-Based Context Injection**:

```javascript
// Retrieve relevant context based on current conversation
async function retrieveRelevantContext(userId, currentMessage) {
    // Extract keywords from current message
    const keywords = extractKeywords(currentMessage);
    
    // Retrieve memories matching keywords
    const relevantMemories = await searchMemoriesByKeywords(userId, keywords);
    
    // Sort by relevance
    relevantMemories.sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    // Select top N memories within token budget
    const selectedMemories = selectWithinTokenBudget(relevantMemories, 1000);
    
    // Format for prompt injection
    return formatMemoriesForPrompt(selectedMemories);
}

function formatMemoriesForPrompt(memories) {
    let formatted = "# Relevant Context\n\n";
    
    for (const memory of memories) {
        formatted += `**${memory.content.title}**\n`;
        formatted += `${memory.content.summary}\n\n`;
    }
    
    return formatted;
}
```

### 7.10 Implementation Recommendations

**For Caretaker Agent Development**:

1. **Adopt Interval-Based Triggering**: Prevents overwhelming both users and systems
2. **Use Structured JSON Format**: Enables semantic search and categorization
3. **Implement Hierarchical Consolidation**: Essential for long-running multi-user systems
4. **Provide User Controls**: Transparency and control build trust
5. **Support Multiple Profiles**: Different users have different needs
6. **Combine Automatic and Manual**: Hybrid approach maximizes quality and coverage
7. **Track Metadata**: Source tracking enables auditing and debugging
8. **Implement Keyword Systems**: Fast retrieval for prompt construction
9. **Respect Privacy Settings**: User-configurable capture rules
10. **Design for Multi-User Scenarios**: Shared vs. private context distinction

### 7.11 Differences from MemoryBooks

**Key Differences for Caretaker Agents**:

1. **Persistence**: Caretaker memories persist across sessions and conversations
2. **Multi-Tenancy**: Must handle multiple users with isolated contexts
3. **Real-Time Retrieval**: Context retrieval happens during conversation, not just creation
4. **Semantic Search**: May need vector embeddings for more advanced retrieval
5. **Access Control**: User A cannot access User B's memories
6. **Scalability**: Must handle thousands of users, not just dozens of chats
7. **API Integration**: Likely needs REST API for external access
8. **Analytics**: Track memory usage, relevance scores, retrieval patterns

### 7.12 Example Caretaker Agent Architecture

**High-Level System Design**:

```
┌─────────────────────────────────────────────────────────────────┐
│                       CARETAKER AGENT SYSTEM                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────┐          ┌──────────────────┐            │
│  │ Conversation      │          │ Memory Extraction │            │
│  │ Interface         │──────────│ Pipeline          │            │
│  │ (Multi-User)      │          │ (MemoryBooks-     │            │
│  └──────────────────┘          │  inspired)        │            │
│           │                     └──────────────────┘            │
│           │                              │                       │
│           ├──────────────────────────────┤                       │
│           │                              │                       │
│           ▼                              ▼                       │
│  ┌──────────────────┐          ┌──────────────────┐            │
│  │ Context Retrieval │          │ Memory Storage    │            │
│  │ Engine            │◄─────────│ (Per-User)        │            │
│  │                   │          │                   │            │
│  │ - Keyword Match   │          │ - JSON Format     │            │
│  │ - Semantic Search │          │ - Metadata        │            │
│  │ - Recency Boost   │          │ - Timestamps      │            │
│  └──────────────────┘          └──────────────────┘            │
│           │                              │                       │
│           │                              │                       │
│           ▼                              ▼                       │
│  ┌──────────────────┐          ┌──────────────────┐            │
│  │ Prompt            │          │ Consolidation     │            │
│  │ Construction      │          │ Service           │            │
│  │                   │          │ (Arc Analysis)    │            │
│  └──────────────────┘          └──────────────────┘            │
│           │                              │                       │
│           ▼                              │                       │
│  ┌──────────────────┐                   │                       │
│  │ LLM Generation    │                   │                       │
│  └──────────────────┘                   │                       │
│           │                              │                       │
│           └──────────────────────────────┘                       │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ User Privacy & Control Layer                              │  │
│  │ - Per-user settings                                        │  │
│  │ - Capture intervals                                        │  │
│  │ - Topic filters                                            │  │
│  │ - Memory dashboard                                         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

This architecture adapts MemoryBooks' patterns while addressing the unique requirements of a multi-user caretaker agent system.

---

## Conclusion

SillyTavern-MemoryBooks provides a robust, production-tested system for automated world info creation using LLMs. Its architecture demonstrates practical solutions to common challenges in conversational AI systems:

1. **Automated context extraction** from unstructured conversations
2. **Reliable LLM integration** with error recovery and JSON parsing
3. **User-controlled automation** balancing convenience and privacy
4. **Hierarchical memory management** preventing information bloat
5. **Flexible configuration** supporting diverse use cases
6. **Integration patterns** compatible with existing systems

For caretaker agent development, MemoryBooks offers valuable patterns that can be adapted for multi-user, persistent context management while maintaining user privacy and control.

The extension's open-source nature and active development make it an excellent reference implementation for teams building similar systems.

---

## Document Metadata

**Research Conducted**: January 2025  
**Repository Version**: Latest stable (1.5.0+)  
**Document Version**: 1.0  
**Lines**: ~1,935  
**Purpose**: Technical reference for LLM context and caretaker agent development  

**Key Files Analyzed**:
- `index.js` (~7000 lines) - Main extension logic
- `stmemory.js` - LLM communication & memory generation
- `autosummary.js` - Automatic triggering system
- `addlore.js` - Lorebook integration
- `chatcompile.js` - Scene compilation
- `arcanalysis.js` - Consolidation system
- `sidePrompts.js` - Side prompt system
- `profileManager.js` - Profile management
- `utils.js` - Utilities & built-in prompts

**Related Documentation**:
- [SillyTavern World Info Architecture](./sillytavern-worldinfo-architecture.md)
- [Marinara Memory System](./marinara-memory-system.md)

---

*End of Document*
