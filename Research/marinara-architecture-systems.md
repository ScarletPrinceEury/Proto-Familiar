# Marinara Engine: Architecture & Systems Documentation

**Repository:** https://github.com/Pasta-Devs/Marinara-Engine  
**Version:** 1.5.6  
**Date Extracted:** April 29, 2026

**Comprehensive documentation of Tool Use, Agent Architecture, Visual UI/Navigation, and Discord Webhooks**

---

## Table of Contents

1. [Tool Use System](#1-tool-use-system)
2. [Agent System Architecture](#2-agent-system-architecture)
3. [Visual UI & Navigation](#3-visual-ui--navigation)
4. [Discord Webhook Architecture](#4-discord-webhook-architecture)
5. [Key Takeaways](#5-key-takeaways)

---

## 1. Tool Use System

### 1.1 Overview

Tools are functions that agents can call during generation to perform actions or retrieve information. Marinara implements a sophisticated tool-calling loop that enables agents to interact with game state, external services, and user-defined functionality.

**Key Components:**
- **10 Built-in Tools** - Core functions for game mechanics, music, and state management
- **Custom Tools** - User-defined tools via database (webhook, script, or static)
- **Tool Calling Loop** - Multi-round LLM ↔ tool execution feedback loop (max 5 rounds)

---

### 1.2 Tool Definition & Registration

**Location:** [`packages/shared/src/types/agent.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/shared/src/types/agent.ts) (lines 613-695)

#### ToolDefinition Interface

```typescript
interface ToolDefinition {
  name: string;              // Unique identifier (snake_case)
  description: string;       // Human-readable purpose
  parameters: JSONSchema;    // JSON Schema for arguments
}
```

#### Built-in Tools List

1. **roll_dice** - RPG dice rolling (2d6, 1d20+5, etc.)
   - Parameters: `notation` (string)
   - Returns: `{ notation, rolls, sum, modifier, total, display }`

2. **update_game_state** - Modify player/NPC stats, inventory, quests
   - Parameters: `type, target, key, value, description`
   - Types: `stat_change, inventory_add, quest_update, etc.`

3. **set_expression** - Change character sprite expressions
   - Parameters: `characterName, expression`
   - Returns: `{ characterName, expression, display }`

4. **trigger_event** - Narrative events (NPC entrance, quest start, combat)
   - Parameters: `eventType, description, involvedCharacters`
   - Types: `npc_entrance, quest_start, combat_start, etc.`

5. **search_lorebook** - Query world information
   - Parameters: `query, category` (optional)
   - Returns: `{ query, category, results, count }`

6. **spotify_get_playlists** - List Spotify libraries
   - Returns user's playlists

7. **spotify_get_playlist_tracks** - Get tracks from playlist
   - Parameters: `playlistId` (use `'liked'` for Liked Songs)
   - Returns up to 500 tracks

8. **spotify_search** - Find music by query
   - Parameters: `query, type` (track/playlist/album)

9. **spotify_play** - Play tracks/playlists
   - Parameters: `uris` (array of Spotify URIs)

10. **spotify_set_volume** - Control volume
    - Parameters: `volume` (0-100)

---

### 1.3 Custom Tool Storage

**Database Schema:** [`packages/server/src/db/schema/custom-tools.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/server/src/db/schema/custom-tools.ts)

```typescript
interface CustomTool {
  id: string;                     // Primary key
  name: string;                   // Tool identifier (snake_case, lowercase)
  description: string;            // What it does
  parametersSchema: string;       // JSON Schema (stored as text)
  executionType: "webhook" | "static" | "script";
  webhookUrl?: string;            // For webhook execution
  staticResult?: string;          // For static results
  scriptBody?: string;            // JavaScript for script execution
  enabled: boolean;               // Toggle flag
  createdAt: string;
  updatedAt: string;
}
```

**Storage API:** [`packages/server/src/services/storage/custom-tools.storage.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/server/src/services/storage/custom-tools.storage.ts)

```typescript
// Available methods
list()                  // Get all tools
listEnabled()           // Get only enabled tools
getById(id)            // Fetch specific tool
getByName(name)        // Search by name
create(input)          // Insert new tool
update(id, data)       // Modify tool
remove(id)             // Delete tool
```

---

### 1.4 Tool Execution Architecture

#### Tool Executor Core

**Location:** [`packages/server/src/services/tools/tool-executor.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/server/src/services/tools/tool-executor.ts) (lines 0-40)

```typescript
export async function executeToolCalls(
  toolCalls: LLMToolCall[],
  context?: ToolExecutionContext,
): Promise<ToolExecutionResult[]>
```

**Execution Flow:**
1. Receive array of tool calls from LLM
2. Parse JSON arguments for each call
3. Execute individually (built-in or custom)
4. Collect results as strings
5. Return all results back to agent

**ToolExecutionContext:**
```typescript
interface ToolExecutionContext {
  gameState?: GameState;              // Current game state for mutations
  customTools?: CustomTool[];         // Loaded custom tools from DB
  searchLorebook?: SearchFunction;    // Lorebook search function
  spotify?: SpotifyCredentials;       // Spotify API credentials
}
```

#### Single Tool Execution

**Location:** `tool-executor.ts` (lines 84-107)

```typescript
async function executeSingleTool(
  name: string,
  args: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<unknown>
```

**Routing Logic:**
- Built-in tools → direct implementation
- Unknown → search `context.customTools`
- Not found → error response

---

### 1.5 Built-in Tool Implementations

#### rollDice (lines 198-214)

```typescript
function rollDice(notation: string) {
  // Parse: "2d6", "1d20+5", "3d8-2"
  // Validate: 1-100 dice, 2-1000 sides
  // Generate random rolls
  return {
    notation: string,
    rolls: number[],
    sum: number,
    modifier: number,
    total: number,
    display: string
  };
}
```

#### updateGameState (lines 216-230)

```typescript
function updateGameState(args: {
  type: "stat_change" | "inventory_add" | "quest_update" | ...,
  target: string,      // Character ID or name
  key: string,         // Stat/item name
  value: any,          // New value
  description: string  // Human-readable change
}) {
  // Returns instruction for client/pipeline to apply
  return { type, target, key, value, description };
}
```

#### setExpression (lines 232-237)

```typescript
function setExpression(args: {
  characterName: string,
  expression: string
}) {
  return {
    characterName,
    expression,
    display: `${characterName}: ${expression}`
  };
}
```

#### triggerEvent (lines 239-245)

```typescript
function triggerEvent(args: {
  eventType: "npc_entrance" | "quest_start" | "combat_start" | ...,
  description: string,
  involvedCharacters: string[]
}) {
  return {
    eventType,
    description,
    involvedCharacters,
    display: description
  };
}
```

#### searchLorebook (lines 247-268)

```typescript
async function searchLorebook(args: {
  query: string,
  category?: string
}, context: ToolExecutionContext) {
  // Calls injected search function
  const results = await context.searchLorebook(query, category);
  return {
    query,
    category,
    results: results.map(r => ({
      name: r.name,
      content: r.content,
      keys: r.keys
    })),
    count: results.length
  };
}
```

---

### 1.6 Custom Tool Execution Types

**Location:** `tool-executor.ts` (lines 120-184)

#### 1. Static Execution (lines 121-122)

Returns configured string immediately with no processing.

```typescript
if (tool.executionType === "static") {
  return tool.staticResult || "";
}
```

**Use Case:** Lookup tables, fixed responses, configuration values

#### 2. Webhook Execution (lines 124-140)

POSTs to external endpoint and returns response.

```typescript
if (tool.executionType === "webhook") {
  const response = await fetch(tool.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: tool.name, arguments: args }),
    signal: AbortSignal.timeout(10000), // 10s timeout
  });
  
  const text = await response.text();
  try {
    return JSON.parse(text); // Parse JSON if possible
  } catch {
    return text; // Return raw text otherwise
  }
}
```

**Use Case:** External APIs, custom backends, microservices integration

#### 3. Script Execution (lines 142-173)

Sandboxed Node.js execution with timeout.

```typescript
if (tool.executionType === "script") {
  const sandbox = {
    args,
    JSON,
    Math,
    String,
    Number,
    Date,
    Array,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
  };
  
  const script = new vm.Script(`(function() { ${tool.scriptBody} })()`);
  const context = vm.createContext(sandbox);
  
  // 5s execution timeout
  const result = script.runInContext(context, {
    timeout: 5000,
    breakOnSigint: true,
  });
  
  return result;
}
```

**Available Globals:**
- `args` - Tool arguments object
- Standard JS: `JSON, Math, String, Number, Date, Array`
- Parsing: `parseInt, parseFloat, isNaN, isFinite`

**Security:** Runs in isolated VM context with no access to filesystem, network, or Node APIs.

**Use Case:** Simple calculations, data transformations, custom logic

---

### 1.7 Tool Calling in Agents

#### Integration with Agent Execution

**Location:** [`packages/server/src/services/agents/agent-executor.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/server/src/services/agents/agent-executor.ts) (lines 200-265)

**Tool-Using Agents:**
- Receive `AgentToolContext` during execution
- Context includes tool definitions array
- Agent can be configured with specific tools via `DEFAULT_AGENT_TOOLS` mapping

#### Tool Loop (lines 200-265)

```typescript
async function executeAgentWithTools(
  config: AgentExecConfig,
  initialMessages: ChatMessage[],
  provider: BaseLLMProvider,
  model: string,
  temperature: number,
  maxTokens: number,
  toolContext: AgentToolContext,
  streamResponses: boolean,
  startTime: number,
  signal?: AbortSignal,
): Promise<AgentResult>
```

**Loop Flow (up to 5 rounds):**

```
1. Call LLM with tool definitions
2. Parse response for tool calls
3. If tool calls present:
   ├─ Execute each tool call via toolContext.executeToolCall(tc)
   ├─ Collect results
   ├─ Add to message history with role: "tool"
   └─ Loop back to step 1
4. If no tool calls or max rounds reached → done
5. Return final response
```

**Message Format in Loop:**

```typescript
loopMessages.push({
  role: "tool",
  content: JSON.stringify(toolResult),
  tool_call_id: tc.id,
  name: tc.function.name,
});
```

**Key Insight:** Results feed back into message history, enabling multi-turn tool use. The LLM can observe tool results and decide to call more tools or provide a final answer.

---

### 1.8 Agent Tool Configuration

**Location:** `agent.ts` (lines 653-695)

```typescript
export const DEFAULT_AGENT_TOOLS: Record<string, string[]> = {
  "world-state": ["update_game_state"],
  "combat": ["roll_dice", "update_game_state"],
  "spotify": [
    "spotify_get_playlists",
    "spotify_get_playlist_tracks",
    "spotify_search",
    "spotify_play",
    "spotify_set_volume"
  ],
  "expression": ["set_expression"],
  "quest": ["update_game_state"],
  "background": [],
  "illustrator": [],
  // ... other agents with their tool arrays
};
```

**Key Point:** Only specified agents get tool access. Most agents run without tools for faster execution.

---

### 1.9 Frontend Tool Editor

**Location:** [`packages/client/src/components/agents/ToolEditor.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/agents/ToolEditor.tsx) (600+ lines)

**UI Features:**

1. **Name Input**
   - Snake_case validation
   - Must be unique
   - Lowercase only

2. **Description Textarea**
   - Explain what the tool does
   - Shown to LLM in tool definitions

3. **Execution Type Selector**
   - Radio buttons: Static / Webhook / Script
   - Conditional fields based on selection

4. **Parameter Schema Builder**
   - JSON editor for JSON Schema
   - Defines expected arguments
   - Type validation

5. **Conditional Fields:**
   - **Static:** Text input for static result
   - **Webhook:** URL input with validation
   - **Script:** Code editor with syntax highlighting

6. **Save/Delete Actions**
   - Confirmation dialogs
   - Auto-invalidation of agent configs

**React Hooks Used:**
```typescript
useCustomTools()          // Fetch all tools
useCreateCustomTool()     // Create new
useUpdateCustomTool()     // Modify existing
useDeleteCustomTool()     // Remove
```

---

### 1.10 Tool API Routes

**Location:** [`packages/server/src/routes/custom-tools.routes.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/server/src/routes/custom-tools.routes.ts)

```
GET    /custom-tools/          → list all tools
GET    /custom-tools/:id       → get one tool
POST   /custom-tools/          → create new tool
PATCH  /custom-tools/:id       → update tool
DELETE /custom-tools/:id       → remove tool
```

**Example Request (Create Tool):**

```json
POST /custom-tools/
{
  "name": "fetch_weather",
  "description": "Gets current weather for a location",
  "parametersSchema": "{\"type\":\"object\",\"properties\":{\"location\":{\"type\":\"string\"}}}",
  "executionType": "webhook",
  "webhookUrl": "https://api.weather.com/current",
  "enabled": true
}
```

---

## 2. Agent System Architecture

### 2.1 Overview

Agents are AI components that run in three phases around the main LLM generation:

1. **Pre-generation** - Inject context before main call (e.g., knowledge retrieval, prompt review)
2. **Parallel** - Run alongside main generation (e.g., music control, state tracking)
3. **Post-processing** - Modify/analyze completed response (e.g., consistency editing, continuity checks)

---

### 2.2 Agent Types (24 Built-in)

#### Writer Agents
- **prose-guardian** - Enforces writing variety, bans repetition, rotates rhetorical devices
- **continuity** - Detects contradictions in timeline, locations, character states
- **director** - Injects narrative events based on pacing analysis
- **prompt-reviewer** - Analyzes assembled system prompt for issues
- **knowledge-retrieval** - RAG with summaries (reads full lorebook entries)
- **knowledge-router** - Fast entry selection by ID (scans catalog, returns IDs only)
- **editor** - Fixes consistency errors in final response
- **secret-plot-driver** - Hidden story arc management (overarching + scene direction)

#### Tracker Agents
- **world-state** - Date/time/weather/location extraction
- **expression** - Sprite expression selection based on emotions
- **quest** - Quest tracking (create/update/complete/fail)
- **background** - Scene background selection
- **character-tracker** - NPC states (mood, appearance, outfit, thoughts, stats)
- **persona-stats** - Player stats (needs bars: satiety, energy, hygiene, morale)
- **custom-tracker** - User-defined fields

#### Misc/Game Agents
- **echo-chamber** - Twitch chat simulation (viewer reactions)
- **illustrator** - Image generation prompts
- **lorebook-keeper** - Auto-updates lorebook entries
- **card-evolution-auditor** - Proposes character card edits
- **combat** - Combat encounter tracking
- **html** - Inline HTML/CSS/JS injection
- **chat-summary** - Auto-summaries (rolling, append-only)
- **spotify** - Music control (playlist selection, volume)
- **cyoa** - Choose-your-own-adventure options
- **game-master** - RPG narration (GM role)
- **party-player** - NPC party control (all party members)
- **schedule-planner** - Character schedules
- **response-orchestrator** - Group chat coordinator
- **autonomous-messenger** - Idle messaging

---

### 2.3 Agent Pipeline Orchestration

**Location:** [`packages/server/src/services/agents/agent-pipeline.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/server/src/services/agents/agent-pipeline.ts)

#### Core Architecture (lines 0-50)

```typescript
export function createAgentPipeline(
  agents: ResolvedAgent[],
  baseContext: AgentContext,
  onResult?: AgentResultCallback,
)
```

**Returns object with three phases:**

```typescript
{
  preGenerate(): Promise<void>,           // Before main LLM
  runParallel(): Promise<void>,           // During main LLM
  postGenerate(mainResponse): Promise<void>  // After main LLM
}
```

#### Phase Execution with Batching (lines 18-70)

**Grouping Strategy:**

1. Filter agents by phase (`pre_generation` / `parallel` / `post_processing`)
2. Group by provider + model (same provider/model = batch together)
3. Within each group:
   - Separate tool-using agents (run individually for tool loop)
   - Keep non-tool agents (batch together for efficiency)

```typescript
const groups = groupByProviderModel(phaseAgents);
// Each group: provider instance + model string combo
// Example: OpenAI + gpt-4o, Anthropic + claude-3-5-sonnet
```

**Batch Execution (lines 87-130):**

```typescript
// Non-tool agents → executeAgentBatch() (1 LLM call)
// Tool-using agents → executeAgent() (individual, loop-based)
// Results streamed via onResult callback
// Run groups in parallel (different providers work concurrently)

await Promise.all(groups.map(async (group) => {
  const { toolAgents, nonToolAgents } = separateByToolUse(group.agents);
  
  // Batch non-tool agents (efficient)
  if (nonToolAgents.length > 0) {
    const results = await executeAgentBatch(
      nonToolAgents,
      context,
      group.provider,
      group.model
    );
    results.forEach(onResult);
  }
  
  // Individual tool agents (loop needed)
  for (const agent of toolAgents) {
    const result = await executeAgent(
      agent,
      context,
      group.provider,
      group.model,
      toolContext
    );
    onResult(result);
  }
}));
```

**Cost Benefit:** Batching reduces LLM calls dramatically. 5 non-tool agents → 1 call instead of 5.

---

### 2.4 Message Building

**Location:** `agent-executor.ts` (lines 595-690)

For each agent, build multi-turn messages:

#### 1. System Message (constructed in parts)

```xml
<role>
Agent-specific role description
</role>

<lore>
<!-- Lorebook entries -->
<entry name="...">content</entry>

<!-- Character cards -->
<character name="..." id="...">
  description, personality, backstory, etc.
</character>

<!-- User persona -->
<user_persona name="...">
  description, personality, appearance, etc.
</user_persona>
</lore>

<agents>
Agent-specific prompt template with instructions
</agents>

<extras>
<!-- Available sprites -->
<available_sprites>
CharacterName (id): expression1, expression2, ...
</available_sprites>

<!-- Available backgrounds -->
<available_backgrounds>
filename: tags
</available_backgrounds>
</extras>
```

#### 2. Chat History (recent N messages)

- Slice to agent's `contextSize` (default 5 messages)
- Only last 3 assistant messages get game state appended (token optimization)
- Format: `{ role: "user" | "assistant", content: string }`

#### 3. Final User Instruction

```
[Assistant's current response if post-processing]

[Agent results from parallel phase if post-processing]

Now return the requested format(s).
```

---

### 2.5 Batched Execution

**Location:** `agent-executor.ts` (lines 290-360)

```typescript
export async function executeAgentBatch(
  configs: AgentExecConfig[],
  context: AgentContext,
  provider: BaseLLMProvider,
  model: string,
): Promise<AgentResult[]>
```

**Batching Process:**

1. Build combined system prompt with `<agent_task id="type">...</agent_task>` blocks

```xml
<agent_task id="world-state">
Extract the current world state...
</agent_task>

<agent_task id="quest">
Analyze the narrative for quest-related changes...
</agent_task>

<agent_task id="expression">
Analyze the emotional state of each character...
</agent_task>
```

2. Send single LLM request (all agents at once)

3. Parse response looking for `<result agent="type">...</result>` blocks

```xml
<result agent="world-state">
{"date": "March 15", "time": "Evening", ...}
</result>

<result agent="quest">
{"updates": []}
</result>

<result agent="expression">
{"expressions": [...]}
</result>
```

4. Extract individual results per agent

5. Fall back to individual execution if parse fails

**Token Savings Example:**
- 3 agents with 2000 token context each
- Individual: 3 × 2000 = 6000 input tokens
- Batched: 2000 shared context + 3 × 200 task prompts = 2600 input tokens
- **~57% token reduction**

---

### 2.6 Agent Execution (Single Agent)

**Location:** `agent-executor.ts` (lines 101-180)

```typescript
export async function executeAgent(
  config: AgentExecConfig,
  context: AgentContext,
  provider: BaseLLMProvider,
  model: string,
  toolContext?: AgentToolContext,
): Promise<AgentResult>
```

**Execution Steps:**

1. Build system prompt with lore + agent template
2. Build multi-turn message array
3. Determine execution method:
   - If `toolContext && tools.length > 0` → tool loop
   - Else → simple LLM call
4. Parse response based on agent type
5. Return `AgentResult` with result type and data

**Generation Parameters:**
- **Temperature:** 0.3 (low, for reliability and consistency)
- **Max Tokens:** 4096-16384 (configurable per agent)
- **Top P:** 1.0
- **Frequency Penalty:** 0
- **Presence Penalty:** 0

---

### 2.7 Tool-Using Agent Loop

**Location:** `agent-executor.ts` (lines 200-265)

```typescript
async function executeAgentWithTools(
  config: AgentExecConfig,
  initialMessages: ChatMessage[],
  provider: BaseLLMProvider,
  model: string,
  temperature: number,
  maxTokens: number,
  toolContext: AgentToolContext,
  streamResponses: boolean,
  startTime: number,
  signal?: AbortSignal,
): Promise<AgentResult>
```

**Loop Implementation (up to 5 rounds):**

```typescript
let round = 0;
const MAX_TOOL_ROUNDS = 5;
const loopMessages = [...initialMessages];

while (round < MAX_TOOL_ROUNDS) {
  // 1. Call LLM with tools parameter
  const response = await provider.chat({
    messages: loopMessages,
    model,
    temperature,
    maxTokens,
    tools: toolContext.tools, // Tool definitions
  });
  
  // 2. Collect tool calls from response
  const toolCalls = response.tool_calls || [];
  
  if (toolCalls.length === 0) {
    // No more tool calls, we're done
    return parseAgentResponse(response.content, config.type);
  }
  
  // 3. Execute each tool call
  const toolResults = await Promise.all(
    toolCalls.map(tc => toolContext.executeToolCall(tc))
  );
  
  // 4. Add results to message history
  loopMessages.push({
    role: "assistant",
    content: response.content || "",
    tool_calls: toolCalls,
  });
  
  toolResults.forEach((result, idx) => {
    loopMessages.push({
      role: "tool",
      content: JSON.stringify(result),
      tool_call_id: toolCalls[idx].id,
      name: toolCalls[idx].function.name,
    });
  });
  
  round++;
}

// Max rounds reached
return parseAgentResponse(loopMessages[loopMessages.length - 1].content, config.type);
```

**Key Feature:** Results feed back into message history, enabling multi-turn tool use. The agent can observe tool results and decide to call more tools or provide a final answer.

---

### 2.8 Result Types

**Location:** `agent.ts` (lines 0-45)

```typescript
export type AgentResultType =
  | "game_state_update"          // Game state mutations
  | "text_rewrite"               // Edited response text
  | "sprite_change"              // Character expression changes
  | "echo_message"               // Stream chat reactions
  | "quest_update"               // Quest modifications
  | "image_prompt"               // Image generation prompts
  | "context_injection"          // Knowledge injected into context
  | "continuity_check"           // Contradiction flags
  | "director_event"             // Narrative direction
  | "lorebook_update"            // Lorebook entry changes
  | "character_card_update"      // Character card edits
  | "prompt_review"              // Prompt quality analysis
  | "background_change"          // Background selection
  | "character_tracker_update"   // NPC state updates
  | "persona_stats_update"       // Player stat changes
  | "custom_tracker_update"      // User field updates
  | "chat_summary"               // Summary text
  | "spotify_control"            // Music commands
  | "haptic_command"             // Haptic device control
  | "cyoa_choices"               // CYOA options
  | "secret_plot"                // Hidden arc state
  | "game_master_narration"      // GM response
  | "party_action"               // Party member actions
  | "game_map_update"            // Map state changes
  | "game_state_transition"      // State machine transitions
  | "html_injection"             // HTML/CSS/JS blocks
  | "schedule_update";           // Character schedule changes
```

Each result type has a specific data schema that varies by agent. Results are consumed by the frontend or pipeline to update UI state, modify game state, or inject context.

---

### 2.9 Agent Storage & Routing

#### Storage API

**Location:** [`packages/server/src/services/storage/agents.storage.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/server/src/services/storage/agents.storage.ts)

```typescript
// CRUD Operations
list()                     // All agent configs
listEnabled()              // Only enabled agents
getById(id)               // Fetch specific agent
getByType(type)           // Built-in agents by type
create(input)             // New agent config
update(id, data)          // Modify settings
remove(id)                // Delete config

// Tracking
saveRun(data)             // Log execution result
```

**Agent Run Tracking:**
```typescript
interface AgentRun {
  id: string;
  agentConfigId: string;
  chatId: string;
  resultType: AgentResultType;
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  error?: string;
  createdAt: string;
}
```

#### API Routes

**Location:** [`packages/server/src/routes/agents.routes.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/server/src/routes/agents.routes.ts)

```
GET    /agents/                        → list all agents
GET    /agents/:id                     → fetch one agent
POST   /agents/                        → create new agent
PATCH  /agents/:id                     → update agent
DELETE /agents/:id                     → delete agent
PUT    /agents/toggle/:agentType       → toggle built-in agent
GET    /agents/:id/runs                → fetch execution history
```

---

## 3. Visual UI & Navigation

### 3.1 Framework & Architecture

**Technology Stack:**
- **React 18** with TypeScript
- **Zustand** - State management (lightweight, no Redux boilerplate)
- **Tailwind CSS** - Utility-first styling
- **Framer Motion** - Animations and transitions
- **React Query** (@tanstack/react-query) - Server state management
- **Lucide React** - Icon library
- **Portal-based modals/overlays** - Accessibility

---

### 3.2 Navigation Model (State-Driven)

**Location:** [`packages/client/src/stores/ui.store.ts`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/stores/ui.store.ts)

**Key Insight:** **NO URL router** - All navigation is state-based via Zustand store.

#### Panel Types

```typescript
type Panel = 
  | "chat"           // Default view
  | "characters"     // Character management
  | "lorebooks"      // World-building
  | "presets"        // System prompts
  | "connections"    // API connections
  | "agents"         // Agent configs
  | "personas"       // User personas
  | "settings"       // App settings
  | "bot-browser";   // Chub.ai search
```

#### Navigation Targets

```typescript
interface UIStore {
  // Detail editors (replace main chat area)
  characterDetailId: string | null;
  lorebookDetailId: string | null;
  presetDetailId: string | null;
  connectionDetailId: string | null;
  agentDetailId: string | null;
  personaDetailId: string | null;
  
  // Panel state
  rightPanel: Panel | null;
  leftPanelOpen: boolean;
  
  // Modal system
  modal: { type: string; data?: any } | null;
  
  // Navigation functions
  openCharacterDetail(id: string);
  closeCharacterDetail();
  openRightPanel(name: Panel);
  toggleRightPanel(name: Panel);
  closeRightPanel();
  openModal(type: string, data?: any);
  closeModal();
}
```

**Navigation Examples:**

```typescript
// Open character editor
ui.openCharacterDetail("char-123");
// → Sets characterDetailId → AppShell renders CharacterEditor

// Toggle right panel
ui.toggleRightPanel("characters");
// → Sets rightPanel: "characters" → RightPanel renders CharactersPanel

// Open modal
ui.openModal("create-character");
// → Sets modal: { type: "create-character" } → ModalRenderer renders CreateCharacterModal
```

---

### 3.3 Main Layout Components

**Location:** [`packages/client/src/components/layout/AppShell.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/layout/AppShell.tsx)

#### Layout Composition

```jsx
<AppShell>
  ├── <TopBar />              // Navigation buttons, panel toggles
  ├── <LeftPanel />           // Chat list, folders, mode selector
  ├── <ChatArea /> or <DetailEditor />
  │   // Switches based on characterDetailId, lorebookDetailId, etc.
  │   ├── <ConversationView />  (Discord-style)
  │   ├── <ChatRoleplaySurface /> (VN-style)
  │   ├── <GameModeSurface />   (RPG)
  │   └── <CharacterEditor />   (detail view)
  ├── <RightPanel />          // Characters, Lorebooks, Presets, etc.
  └── <ModalRenderer />       // Portal-based modals
```

---

### 3.4 Top Bar

**Location:** [`packages/client/src/components/layout/TopBar.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/layout/TopBar.tsx)

**Elements:**

**Left Section:**
- Home icon (Marinara logo)
- Current chat mode indicator (Conversation / Roleplay / Game)

**Center Section:**
- Chat title (editable on click)
- Settings button (opens chat settings drawer)

**Right Section:** Panel toggle buttons with gradient icons
- **bot-browser** (cyan→blue gradient)
- **characters** (pink→rose gradient)
- **lorebooks** (amber→orange gradient)
- **presets** (purple→violet gradient)
- **connections** (sky→blue gradient)
- **agents** (green→emerald gradient)
- **personas** (yellow→amber gradient)
- **settings** (slate→gray gradient)

**Behavior:**
- Click toggles panel open/close
- Active panel highlighted with gradient border
- Tooltips on hover

---

### 3.5 Left Panel (Chat Navigation)

**Location:** [`packages/client/src/components/layout/LeftPanel.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/layout/LeftPanel.tsx)

**Content:**

1. **New Chat Button**
   - Creates chat in current mode
   - Opens character selection if needed

2. **Chat Mode Selector**
   - Tabs: Conversation / Roleplay / Game
   - Filters chat list by mode

3. **Folder Tree**
   - Drag-to-organize folders
   - Collapsible hierarchy
   - Chat count badges

4. **Chat List**
   - Searchable by title/characters
   - Sortable (recent, alphabetical)
   - Each chat card shows:
     - Character avatar(s)
     - Last message preview
     - Timestamp
     - Unread indicator

**Features:**
- Context menu (right-click): Rename, Move, Delete, Duplicate
- Drag-and-drop to folders
- Pinned chats (top of list)

---

### 3.6 Right Panel System

**Location:** [`packages/client/src/components/layout/RightPanel.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/layout/RightPanel.tsx)

#### Panel Configuration

```typescript
const PANELS: Record<string, LazyExoticComponent> = {
  "bot-browser": lazy(() => import("../panels/BotBrowserPanel")),
  "characters": lazy(() => import("../panels/CharactersPanel")),
  "lorebooks": lazy(() => import("../panels/LorebooksPanel")),
  "presets": lazy(() => import("../panels/PresetsPanel")),
  "connections": lazy(() => import("../panels/ConnectionsPanel")),
  "agents": lazy(() => import("../panels/AgentsPanel")),
  "personas": lazy(() => import("../panels/PersonasPanel")),
  "settings": lazy(() => import("../panels/SettingsPanel")),
};
```

**Features:**
- **Lazy loading** - Code splitting for performance
- **Mounted panels persist** - Avoid re-animation on switch
- **Header:** Icon + title + close button
- **Body:** Scrollable content area

**Layout:**
```jsx
<RightPanel>
  <Header>
    <Icon /> {/* Gradient icon */}
    <Title>{panelName}</Title>
    <CloseButton onClick={closeRightPanel} />
  </Header>
  <Body>
    {/* Panel-specific content */}
  </Body>
</RightPanel>
```

---

### 3.7 Key Panels

#### Characters Panel

**Location:** [`packages/client/src/components/panels/CharactersPanel.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/panels/CharactersPanel.tsx)

**Features:**
- Grid/list view toggle
- Search by name/description
- Sort by name, created date, modified date
- Tag filter (multi-select)
- Bulk selection (delete multiple)
- Actions per character:
  - Edit (opens detail view)
  - Duplicate
  - Delete (with confirmation)
  - Export (downloads JSON)
- Create new character button
- Import from Chub.ai button
- AI-assisted character maker

**Character Card Display:**
```jsx
<CharacterCard>
  <Avatar src={avatar} />
  <Name>{name}</Name>
  <Description>{truncate(description)}</Description>
  <Tags>{tags.join(", ")}</Tags>
  <Actions>
    <EditButton />
    <DuplicateButton />
    <DeleteButton />
  </Actions>
</CharacterCard>
```

---

#### Agents Panel

**Location:** [`packages/client/src/components/panels/AgentsPanel.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/panels/AgentsPanel.tsx)

**Sections:**

1. **Built-in Agents**
   - List of 24 default agents
   - Toggle switch (on/off)
   - Status indicators (enabled/disabled)
   - Phase labels (Pre / Parallel / Post)

2. **Custom Agents**
   - User-created agents
   - Edit/delete actions
   - Create new agent button

3. **Custom Tools**
   - User-defined tools
   - Edit/delete actions
   - Create new tool button

4. **Regex Scripts**
   - Text transformation scripts
   - Pattern + replacement rules
   - Create new script button

**View Options:**
- Filter by category (Writer / Tracker / Game / Misc)
- Filter by status (All / Enabled / Disabled)
- Sort by name, phase, execution order

---

#### Agent Editor

**Location:** [`packages/client/src/components/modals/EditAgentModal.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/modals/EditAgentModal.tsx)

**Form Fields:**

1. **Name** - Agent identifier
2. **Description** - What the agent does
3. **Phase** - Radio buttons:
   - Pre-generation
   - Parallel
   - Post-processing
4. **Connection Override** - Optional custom API connection
5. **Model Override** - Optional custom model
6. **Custom Prompt Template** - Agent-specific instructions
7. **Settings:**
   - Context size (messages to include)
   - Temperature override
   - Max tokens override
   - Tool selection (multi-select)
   - Execution order (numeric)

**Actions:**
- Save (validates and updates)
- Cancel (discards changes)
- Delete (with confirmation)

---

#### Tool Editor

**Location:** [`packages/client/src/components/agents/ToolEditor.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/agents/ToolEditor.tsx)

**Full-page editor (like character editor):**

**Sections:**

1. **Tool Name**
   - Input with snake_case validation
   - Must be unique
   - Lowercase only

2. **Description**
   - Textarea explaining purpose
   - Shown to LLM in tool definitions

3. **Execution Type**
   - Radio buttons: Static / Webhook / Script
   - Conditional fields based on selection

4. **Parameter Schema**
   - JSON editor for JSON Schema
   - Defines expected arguments
   - Type validation (string, number, boolean, object, array)

5. **Conditional Fields:**
   - **Static Execution:**
     - Text input for static result
   - **Webhook Execution:**
     - URL input with validation
     - HTTP timeout setting
   - **Script Execution:**
     - Code editor with syntax highlighting
     - Available globals documentation
     - Execution timeout setting

**Actions:**
- Save (validates schema and code)
- Cancel (returns to agents panel)
- Delete (with confirmation)

---

### 3.8 Chat Surface Components

#### Conversation View

**Location:** [`packages/client/src/components/chat/ConversationView.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/chat/ConversationView.tsx)

**Discord-style layout:**

**Features:**
- Chronological message list
- User messages (right-aligned, blue)
- Assistant messages (left-aligned, gray)
- Swipe between alternate responses
- Message actions:
  - Edit
  - Regenerate
  - Delete
  - Copy
  - Branch (create alternate path)
- Input field at bottom
- Attachment button (images)
- Send button

**Message Format:**
```jsx
<Message role="user">
  <Avatar />
  <Content>
    <Name>You</Name>
    <Text>{message}</Text>
    <Timestamp>{time}</Timestamp>
  </Content>
  <Actions>
    <EditButton />
    <DeleteButton />
  </Actions>
</Message>
```

---

#### Roleplay Surface

**Location:** [`packages/client/src/components/chat/ChatRoleplaySurface.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/chat/ChatRoleplaySurface.tsx)

**Visual Novel-style layout:**

**Components:**

1. **Background Layer**
   - Full-screen background image
   - Weather overlays (rain, snow, fog)
   - Particle effects (dust, embers, sparkles)

2. **Sprite Layer**
   - Character sprites (left/right positions)
   - Expression changes
   - Transitions (crossfade, bounce, shake, hop)
   - Scale/opacity animations

3. **Dialogue Box**
   - Bottom-aligned
   - Character name
   - Dialogue text (typewriter effect)
   - Continue button

4. **Toolbar (top)**
   - Summary (chat context manager)
   - World Info (lorebook viewer)
   - Author Notes
   - Settings
   - Image Gallery

5. **HUD Widgets** (optional)
   - World state (date, time, weather, location)
   - Quests
   - Inventory
   - Character stats

**Interaction:**
- Click to advance dialogue
- Swipe sprites to change expressions
- Drag widgets to reposition

---

#### Roleplay HUD

**Location:** [`packages/client/src/components/chat/RoleplayHUD.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/chat/RoleplayHUD.tsx)

**Widget System:**

**Available Widgets:**
1. **World State** - Date, time, weather, location, temperature
2. **Quests** - Active quests with objectives
3. **Inventory** - Items with quantities
4. **Character Stats** - HP, stamina, mana, etc.
5. **Persona Stats** - Needs bars (satiety, energy, hygiene, morale)
6. **Custom Tracker** - User-defined fields

**Features:**
- Drag-to-move (persistent positions)
- Resize handles
- Minimize/maximize
- Settings per widget (show/hide fields)
- Auto-update from agent results

---

### 3.9 Game Mode UI Components

#### Game Mode Surface

**Location:** [`packages/client/src/components/game/GameModeSurface.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/game/GameModeSurface.tsx)

**Layout:**

```
┌─────────────────────────────────────────────┐
│ Top Bar (GM, Party, Combat state)          │
├───────────────┬─────────────────────────────┤
│               │                             │
│  Map View     │  Narration Area            │
│  (grid/node)  │  - GM messages             │
│               │  - Party dialogue          │
│               │  - Combat log              │
│               │  - Input field             │
│               │                             │
├───────────────┴─────────────────────────────┤
│ Bottom Bar (Actions, Abilities, Items)     │
└─────────────────────────────────────────────┘
│ Journal Sidebar (toggleable)                │
└─────────────────────────────────────────────┘
```

**State Machine:**
- **exploration** - Free movement, dialogue
- **combat** - Turn-based combat
- **dialogue** - NPC conversation
- **rest** - Camp/rest screen
- **cutscene** - Non-interactive narration

---

#### Game Widgets

**Location:** [`packages/client/src/components/game/GameWidgetPanel.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/game/GameWidgetPanel.tsx)

**Pre-built React Components:**

1. **StatBlockWidget**
   - Character name + avatar
   - HP bar (current/max)
   - Status effects
   - Stats (strength, dexterity, etc.)

2. **InventoryGridWidget**
   - Grid-based inventory
   - Item icons
   - Quantities
   - Drag-to-reorder

3. **CounterWidget**
   - Simple numbered counters
   - Increment/decrement buttons
   - Labels

4. **ListWidget**
   - Scrollable lists
   - Checkboxes
   - Add/remove items

5. **RelationshipMeterWidget**
   - NPC relationship bars
   - Color-coded (red to green)
   - Hover for description

6. **TimerWidget**
   - Countdown timer
   - Pause/resume
   - Alert on zero

**HUD Customization:**
- Add/remove widgets
- Reorder via drag-and-drop
- Widget settings modal

---

#### Game Journal

**Location:** [`packages/client/src/components/game/GameJournal.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/game/GameJournal.tsx)

**Tabs:**

1. **All** - Complete timeline of events
2. **NPCs** - Character profiles and relationships
3. **Locations** - Visited locations with descriptions
4. **Inventory** - Full inventory list
5. **Library** - Lore entries and documents
6. **Notes** - User-written notes

**Features:**
- Auto-updated from game state (no LLM)
- Search/filter
- Persistent across sessions
- Export to markdown

---

#### Game Map

**Location:** [`packages/client/src/components/game/GameMap.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/game/GameMap.tsx)

**Map Types:**

1. **GridMap** - Exploration grid
   - Square tiles
   - Party position indicator
   - Fog of war
   - Terrain types (grass, water, mountain)
   - Click to move

2. **NodeMap** - Dungeon/interior nodes
   - Connected nodes (rooms)
   - Party position
   - Visited/unvisited states
   - Click node to navigate

**Features:**
- Zoom in/out
- Pan via drag
- Minimap (corner overlay)
- Legend (terrain/icons)

---

### 3.10 Modal System

**Location:** [`packages/client/src/components/layout/ModalRenderer.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/layout/ModalRenderer.tsx)

**Modal Types (switch on `modal.type`):**

```typescript
const MODAL_COMPONENTS = {
  "create-character": CreateCharacterModal,
  "import-character": ImportCharacterModal,
  "character-maker": CharacterMakerModal,    // AI-generated
  "create-lorebook": CreateLorebookModal,
  "lorebook-maker": LorebookMakerModal,      // AI-generated
  "create-preset": CreatePresetModal,
  "bot-browser": BotBrowserModal,            // Chub.ai search
  "edit-agent": EditAgentModal,
  "settings": SettingsModal,
  "confirm": ConfirmModal,                   // Generic confirmation
};
```

**Modal Rendering:**

```jsx
<ModalRenderer>
  {modal && (
    <AnimatePresence>
      <Backdrop onClick={closeModal} />
      <ModalComponent
        type={modal.type}
        data={modal.data}
        onClose={closeModal}
      />
    </AnimatePresence>
  )}
</ModalRenderer>
```

---

#### Base Modal Component

**Location:** [`packages/client/src/components/ui/Modal.tsx`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/client/src/components/ui/Modal.tsx)

**Features:**
- **Backdrop** - Click-to-close (optional)
- **Escape key** - Closes modal
- **Enter key** - Submits form (if has submit button)
- **Animations** - Fade in/out with Framer Motion
- **Customizable width** - sm / md / lg / xl
- **Portal-based** - Renders outside DOM hierarchy

**Props:**
```typescript
interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: "sm" | "md" | "lg" | "xl";
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}
```

---

### 3.11 UI Primitives

**Location:** [`packages/client/src/components/ui/`](https://github.com/Pasta-Devs/Marinara-Engine/tree/main/packages/client/src/components/ui)

**Key Components:**

1. **Modal** - Base modal wrapper
2. **ColorPicker** - Solid + gradient picker with presets
3. **ExpandedTextarea** - Full-screen text editor with markdown preview
4. **EmojiPicker** - Searchable emoji popover
5. **GifPicker** - GIF search (Giphy API integration)
6. **HelpTooltip** - Hover icon with informational tooltip
7. **ContextMenu** - Right-click menu (portal-based)
8. **DraftNumberInput** - Auto-commit number input with validation
9. **TagInput** - Multi-tag input with autocomplete
10. **FileUpload** - Drag-and-drop file upload

---

### 3.12 Styling & Theming

**CSS Variables (custom properties):**

```css
:root {
  /* Primary colors */
  --primary: #7c3aed;                    /* Purple */
  --primary-foreground: #ffffff;
  
  /* Semantic colors */
  --destructive: #ef4444;                /* Red */
  --muted-foreground: #6b7280;           /* Gray */
  
  /* Layout */
  --border: rgba(255, 255, 255, 0.1);
  --background: #0f172a;                 /* Dark blue */
  --card: #1e293b;                       /* Lighter dark */
  --secondary: #334155;                  /* Medium gray */
  
  /* Sidebar */
  --sidebar-border: rgba(255, 255, 255, 0.05);
}
```

**Themes:**

1. **default** - Y2K Marinara theme
   - Vibrant gradients
   - Purple/pink accents
   - Dark background

2. **sillytavern** - Classic SillyTavern look
   - Neutral colors
   - Light borders
   - Familiar layout

**Theme Toggle:** `setVisualTheme(theme)` in settings panel

---

### 3.13 Responsive Design

**Tailwind Breakpoints:**

```css
/* Mobile */
@media (max-width: 768px) {
  - Hidden panels (left/right collapse)
  - Smaller fonts
  - Touch-friendly controls
  - Scrollable regions
}

/* Tablet */
@media (max-width: 1024px) {
  - Single panel view
  - Hamburger menu
}

/* Desktop */
@media (min-width: 1024px) {
  - Full multi-panel layout
  - Hover states
  - Keyboard shortcuts
}
```

---

### 3.14 Animation & Motion

**Framer Motion Usage:**

```typescript
// Panel transitions (slide in/out)
<motion.div
  initial={{ x: 300, opacity: 0 }}
  animate={{ x: 0, opacity: 1 }}
  exit={{ x: 300, opacity: 0 }}
  transition={{ type: "spring", damping: 25 }}
/>

// Modal fade-in/out
<motion.div
  initial={{ opacity: 0, scale: 0.95 }}
  animate={{ opacity: 1, scale: 1 }}
  exit={{ opacity: 0, scale: 0.95 }}
/>

// Sprite expression transitions
<motion.img
  key={expression}
  initial={{ opacity: 0 }}
  animate={{ opacity: 1 }}
  transition={{ duration: 0.3 }}
/>
```

**Weather/Particle Effects:**
- Parallax scrolling
- CSS animations
- Canvas-based particles

---

### 3.15 State Management (Zustand)

**Store Files:**

1. **UI Store** (`ui.store.ts`) - Navigation, modal, panel state
2. **Chat Store** (`chat.store.ts`) - Current chat, messages
3. **Game Store** (`game-mode.store.ts`) - Game state, widgets
4. **Agent Store** (`agent.store.ts`) - Active agents, results
5. **Sidecar Store** (`sidecar.store.ts`) - Local LLM connection

**Example Store:**

```typescript
interface UIStore {
  // State
  rightPanel: Panel | null;
  modal: { type: string; data?: any } | null;
  
  // Actions
  openRightPanel: (name: Panel) => void;
  closeRightPanel: () => void;
  openModal: (type: string, data?: any) => void;
  closeModal: () => void;
}

const useUIStore = create<UIStore>((set) => ({
  rightPanel: null,
  modal: null,
  
  openRightPanel: (name) => set({ rightPanel: name }),
  closeRightPanel: () => set({ rightPanel: null }),
  openModal: (type, data) => set({ modal: { type, data } }),
  closeModal: () => set({ modal: null }),
}));
```

---

### 3.16 React Query Hooks

**Server State Management:**

```typescript
// Chat hooks
useChats()                  // List all chats
useChat(id)                // Fetch specific chat
useCreateChat()            // Create new chat
useUpdateChat()            // Update chat metadata
useDeleteChat()            // Delete chat

// Character hooks
useCharacters()            // List all characters
useCharacter(id)          // Fetch specific character
useCreateCharacter()      // Create new character
useUpdateCharacter()      // Update character
useDeleteCharacter()      // Delete character

// Agent hooks
useAgentConfigs()         // List all agent configs
useAgent(id)              // Fetch specific agent
useCreateAgent()          // Create custom agent
useUpdateAgent()          // Update agent settings
useDeleteAgent()          // Delete agent

// Tool hooks
useCustomTools()          // List all tools
useCreateCustomTool()     // Create new tool
useUpdateCustomTool()     // Update tool
useDeleteCustomTool()     // Delete tool
```

**Pattern:**

```typescript
const { data, isLoading, error } = useCharacters();

const createMutation = useCreateCharacter();
createMutation.mutate(newCharacter, {
  onSuccess: () => {
    // Auto-invalidates character list
    toast.success("Character created!");
  },
});
```

---

### 3.17 Key Workflows

#### Create Character Workflow

```
1. User clicks "+" button in Characters panel
   └─ ui.openModal("create-character")

2. ModalRenderer renders CreateCharacterModal
   └─ Form with name, description, etc.

3. User fills form and clicks "Create"
   └─ useCreateCharacter().mutate(data)

4. Server saves character to database
   └─ Returns character ID

5. React Query invalidates character list
   └─ Refetches characters automatically

6. Panel updates with new character
   └─ Modal closes
   └─ Toast notification
```

---

#### Edit Agent Workflow

```
1. User clicks agent in Agents panel
   └─ ui.openAgentDetail(agentId)

2. AppShell renders AgentDetailEditor instead of ChatArea
   └─ Loads agent config via useAgent(id)

3. User modifies settings (prompt, phase, tools)
   └─ Form updates local state

4. User clicks "Save"
   └─ useUpdateAgent().mutate(data)

5. Server updates agent config
   └─ Returns updated config

6. React Query invalidates agent list
   └─ Refetches agents

7. User clicks "Close" or back button
   └─ ui.closeAgentDetail()
   └─ Returns to chat view
```

---

#### Run Generation Workflow

```
1. User types message in ChatInput
   └─ Local state updates

2. User clicks Send button
   └─ useGenerate().mutate({ message, chatId })

3. Backend opens SSE stream
   ├─ Runs agent pipeline (pre-gen, parallel, post-processing)
   ├─ Runs main LLM generation
   └─ Streams partial tokens

4. Frontend receives SSE events
   ├─ Agent results → onResult callback
   │   └─ Updates agent UI badges
   ├─ Partial tokens → appends to message
   │   └─ Typewriter effect
   └─ Final message → adds to history

5. UI updates
   ├─ Scroll to bottom
   ├─ Enable input
   └─ Show agent execution stats
```

---

## 4. Discord Webhook Architecture

### 4.1 Overview

Marinara Engine implements a **fire-and-forget webhook system** that mirrors game mode messages to Discord channels. The system uses per-webhook rate limiting, automatic retry logic, and respects Discord's rate limits.

**Central Service:** [`packages/server/src/services/discord-webhook.ts`](https://github.com/pasta-devs/marinara-engine/blob/main/packages/server/src/services/discord-webhook.ts)

---

### 4.2 Configuration Flow

#### 1. UI Configuration

**Location:** [`ChatSettingsDrawer.tsx`](https://github.com/pasta-devs/marinara-engine/blob/main/packages/client/src/components/chat/ChatSettingsDrawer.tsx) (lines 3325-3345)

**UI Elements:**
- Text input for Discord webhook URL
- Real-time validation with regex
- Save on change (debounced)
- Clear button

**Validation Pattern:**
```javascript
/^https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/
```

**Example Valid URL:**
```
https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz123456
```

---

#### 2. API Endpoint

**Location:** `chats.routes.ts` (lines 103-119)

```
PATCH /chat/:id/metadata
```

**Request Body:**
```json
{
  "discordWebhookUrl": "https://discord.com/api/webhooks/..."
}
```

**Validation:**
- URL format check
- Returns 400 if invalid
- Stores normalized URL in chat metadata

**Response:**
```json
{
  "success": true,
  "metadata": {
    "discordWebhookUrl": "https://discord.com/api/webhooks/..."
  }
}
```

---

#### 3. Storage

**Type:** `ChatMetadata` field in [`packages/shared/src/types/chat.ts`](https://github.com/pasta-devs/marinara-engine/blob/main/packages/shared/src/types/chat.ts) (lines 124-137)

```typescript
interface ChatMetadata {
  discordWebhookUrl?: string;  // Optional webhook URL
  // ... other metadata fields
}
```

**Storage:** SQLite database, chat table, metadata column (JSON)

---

### 4.3 Webhook Triggers

All webhook triggers occur in **Game Mode** via the game routes.

**Location:** [`game.routes.ts`](https://github.com/pasta-devs/marinara-engine/blob/main/packages/server/src/routes/game.routes.ts)

#### Primary Triggers

1. **Party Turn Responses** (Line 4312)
   ```typescript
   mirrorGameMessageToDiscord(meta, cleanRaw, "Party");
   ```
   - Triggered: After party members respond
   - Speaker: "Party"
   - Content: Party dialogue and actions

2. **Session Start Recap** (Line 2495)
   ```typescript
   mirrorGameMessageToDiscord(updatedNewMeta, recapText, "Narrator");
   ```
   - Triggered: When game session starts
   - Speaker: "Narrator"
   - Content: Session recap summary

3. **Session Conclusion** (Line 2714)
   ```typescript
   mirrorGameMessageToDiscord(meta, summary, "Narrator");
   ```
   - Triggered: When game session ends
   - Speaker: "Narrator"
   - Content: Session summary

---

### 4.4 Rate Limiting & Queuing

**Constants:**

```typescript
const DISCORD_RATE_LIMIT_INTERVAL = 1200; // 1200ms between requests (~50 req/min)
const MAX_MESSAGE_LENGTH = 2000;          // Discord message limit
const MAX_USERNAME_LENGTH = 80;           // Discord username limit
```

**Queue System:**

```typescript
const webhookQueues = new Map<string, {
  busy: boolean;
  queue: Array<() => Promise<void>>;
}>();
```

**Per-Webhook Serialization:**
- Each webhook URL gets its own queue
- Prevents concurrent requests to same webhook
- Ensures 1200ms minimum interval between posts
- Multiple webhooks can operate in parallel

**Queue Processing:**

```typescript
async function enqueueWebhookPost(webhookUrl: string, task: () => Promise<void>) {
  let queueEntry = webhookQueues.get(webhookUrl);
  
  if (!queueEntry) {
    queueEntry = { busy: false, queue: [] };
    webhookQueues.set(webhookUrl, queueEntry);
  }
  
  queueEntry.queue.push(task);
  
  if (!queueEntry.busy) {
    processQueue(webhookUrl);
  }
}

async function processQueue(webhookUrl: string) {
  const queueEntry = webhookQueues.get(webhookUrl);
  if (!queueEntry || queueEntry.queue.length === 0) return;
  
  queueEntry.busy = true;
  
  while (queueEntry.queue.length > 0) {
    const task = queueEntry.queue.shift();
    await task();
    await sleep(DISCORD_RATE_LIMIT_INTERVAL); // Wait 1200ms
  }
  
  queueEntry.busy = false;
}
```

---

### 4.5 Message Mirroring Function

**Location:** `discord-webhook.ts`

```typescript
async function mirrorGameMessageToDiscord(
  metadata: ChatMetadata,
  content: string,
  speaker: string,
) {
  if (!metadata.discordWebhookUrl) return;
  
  const truncatedContent = content.length > MAX_MESSAGE_LENGTH
    ? content.substring(0, MAX_MESSAGE_LENGTH - 3) + "..."
    : content;
  
  const payload = {
    content: truncatedContent,
    username: speaker.substring(0, MAX_USERNAME_LENGTH),
    avatar_url: undefined, // Optional: character avatar URL
  };
  
  await enqueueWebhookPost(metadata.discordWebhookUrl, async () => {
    await postToDiscordWebhook(metadata.discordWebhookUrl, payload);
  });
}
```

---

### 4.6 Discord API Integration

**HTTP Request:**

```typescript
async function postToDiscordWebhook(url: string, payload: WebhookPayload) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    
    if (response.status === 429) {
      // Rate limited by Discord
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
      
      logger.warn(`Discord rate limit hit, retrying after ${waitMs}ms`);
      await sleep(waitMs);
      
      // Retry once
      return postToDiscordWebhook(url, payload);
    }
    
    if (!response.ok) {
      logger.error(`Discord webhook failed: ${response.status}`);
    }
  } catch (error) {
    logger.error("Discord webhook error:", error);
    // Fire-and-forget: don't throw, just log
  }
}
```

---

### 4.7 Error Handling

**429 Rate Limits:**
- Respects `Retry-After` header
- Automatic backoff with retry
- Single retry attempt

**Network Errors:**
- Logged via Pino logger
- Never thrown (fire-and-forget)
- Non-blocking to generation pipeline

**Invalid URLs:**
- Caught during configuration
- Validation error returned to UI
- Not saved to database

**Missing Webhook:**
- Silent no-op
- No error if webhook URL not configured
- Logs skipped at debug level

---

### 4.8 Payload Format

**WebhookPayload Interface:**

```typescript
interface WebhookPayload {
  content: string;        // Message text (max 2000 chars)
  username?: string;      // Display name (max 80 chars)
  avatar_url?: string;    // Optional avatar URL
}
```

**Example Payloads:**

**Party Dialogue:**
```json
{
  "content": "[Eldric] [main] [determined]: \"We need to press forward. The temple won't wait.\"",
  "username": "Party"
}
```

**Session Recap:**
```json
{
  "content": "The party has successfully defeated the bandits and secured the village. They now prepare to journey to the ancient temple.",
  "username": "Narrator"
}
```

**Session Summary:**
```json
{
  "content": "Session concluded. The party earned 500 XP and found a mysterious artifact. Next session: Exploring the temple depths.",
  "username": "Narrator"
}
```

---

### 4.9 Message Formatting

**Content Processing:**

1. **Truncation:**
   - If `content.length > 2000`, truncate to 1997 chars + "..."
   - Ensures compliance with Discord limit

2. **Username Truncation:**
   - If `username.length > 80`, truncate to 80 chars
   - Ensures compliance with Discord limit

3. **No Special Formatting:**
   - Raw text sent as-is
   - No markdown processing
   - No emoji conversion

**Example Processing:**

```typescript
// Input
const rawMessage = "A very long message that exceeds 2000 characters...";

// Processed
const payload = {
  content: rawMessage.length > 2000
    ? rawMessage.substring(0, 1997) + "..."
    : rawMessage,
  username: "Party",
};
```

---

### 4.10 Discord Channel Setup

**User Workflow:**

1. **Create Discord Webhook:**
   - Go to Discord channel settings
   - Select "Integrations" → "Webhooks"
   - Click "New Webhook"
   - Copy webhook URL

2. **Configure in Marinara:**
   - Open chat settings
   - Paste webhook URL
   - Save (auto-validates)

3. **Start Game Session:**
   - Messages automatically mirror to Discord
   - No additional configuration needed

**Discord Display:**

```
[BOT] Party — Today at 12:34 PM
[Eldric] [main] [determined]: "We need to press forward."

[BOT] Narrator — Today at 12:35 PM
The party ventures deeper into the forest.
```

---

### 4.11 Architecture Diagram

```
┌─────────────────────────────────────────────┐
│ User configures Discord webhook URL         │
│ └─ ChatSettingsDrawer → PATCH /chat/:id    │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │ ChatMetadata stored   │
        │ in SQLite database    │
        └───────────┬───────────┘
                    │
                    ▼
        ┌───────────────────────────────┐
        │ Game Mode generates message   │
        │ └─ Party turn / Session event │
        └───────────┬───────────────────┘
                    │
                    ▼
        ┌───────────────────────────────┐
        │ mirrorGameMessageToDiscord()  │
        │ └─ Formats payload            │
        └───────────┬───────────────────┘
                    │
                    ▼
        ┌───────────────────────────────┐
        │ enqueueWebhookPost()          │
        │ └─ Adds to per-webhook queue  │
        └───────────┬───────────────────┘
                    │
                    ▼
        ┌───────────────────────────────┐
        │ processQueue()                │
        │ └─ Waits 1200ms between posts│
        └───────────┬───────────────────┘
                    │
                    ▼
        ┌───────────────────────────────┐
        │ postToDiscordWebhook()        │
        │ └─ POST to Discord API        │
        └───────────┬───────────────────┘
                    │
                    ▼
        ┌───────────────────────────────┐
        │ Discord channel receives msg  │
        │ └─ Displays as webhook bot    │
        └───────────────────────────────┘
```

---

### 4.12 Key Design Decisions

**1. Fire-and-Forget Pattern**
- Webhook failures don't block game generation
- Non-blocking, async execution
- Errors logged but not surfaced to user

**2. Per-Webhook Queuing**
- Prevents rate limit violations
- Each webhook URL has independent queue
- Multiple webhooks can operate in parallel

**3. Automatic Retry (429 Only)**
- Single retry attempt on rate limit
- Respects `Retry-After` header
- Other errors are logged and dropped

**4. Game Mode Only**
- Webhooks only fire in Game Mode
- No webhook support in Conversation/Roleplay modes
- Keeps feature scope focused

**5. Simple Payload Format**
- Plain text messages
- No embeds or rich formatting
- Minimal processing overhead

---

## 5. Key Takeaways

### 5.1 Tool System Insights

1. **Three Execution Types:** Static (instant), Webhook (external), Script (sandboxed)
2. **Tool Loop:** Up to 5 rounds of LLM ↔ tool execution feedback
3. **Per-Agent Tool Assignment:** Only specified agents get tool access
4. **Sandboxed Execution:** Scripts run in isolated VM with no file/network access
5. **Custom Tools:** User-extensible via UI, stored in database

**Application to Caretaker Agent:**
- Tools can be used for cross-chat actions (relay, reminder delivery)
- Webhook tools could integrate with external calendars, task managers
- Script tools for data transformations (privacy checks, importance scoring)

---

### 5.2 Agent System Insights

1. **Three-Phase Pipeline:** Pre-gen, Parallel, Post-processing
2. **Smart Batching:** Same provider/model agents batched into single LLM call
3. **Tool Loop for Tool-Using Agents:** Individual execution with feedback loop
4. **25+ Result Types:** Each agent returns typed results for UI/pipeline consumption
5. **Low Temperature (0.3):** Agents prioritize reliability over creativity

**Application to Caretaker Agent:**
- Pre-gen agents could inject shared knowledge, pending tasks
- Parallel agents could track cross-chat state, relationships
- Post-processing agents could classify privacy, extract knowledge
- Batching reduces cost for multiple cross-chat agents

---

### 5.3 UI/Navigation Insights

1. **State-Driven Navigation:** No URL router, all navigation via Zustand store
2. **Lazy-Loaded Panels:** Code splitting for performance
3. **Portal-Based Modals:** Accessibility and z-index management
4. **React Query for Server State:** Auto-invalidation, caching, optimistic updates
5. **Framer Motion for Animations:** Smooth transitions, parallax effects

**Application to Caretaker Agent:**
- State-driven nav simplifies multi-user chat switching
- Panel system could show user relationship graph, shared context
- Modals for task creation, relay composition
- React Query hooks for real-time multi-chat state

---

### 5.4 Discord Webhook Insights

1. **Fire-and-Forget:** Non-blocking, async delivery
2. **Per-Webhook Rate Limiting:** Independent queues prevent violations
3. **Game Mode Only:** Focused feature scope
4. **Automatic Retry (429):** Respects Discord rate limits
5. **Simple Payload:** Plain text, no embeds

**Application to Caretaker Agent:**
- Webhooks could notify users of relayed messages (Discord, Slack, email)
- Rate limiting pattern applicable to any external API integration
- Fire-and-forget ensures main conversation flow isn't blocked

---

### 5.5 Overall Architecture Patterns

**Component Modularity:**
- Tools, Agents, UI components are loosely coupled
- Database storage abstraction layer
- Provider-agnostic LLM interface

**Performance Optimizations:**
- Batching (agents, API calls)
- Lazy loading (UI components, lorebook entries)
- Caching (React Query, Zustand persist)
- Streaming (SSE for generation, agent results)

**Extensibility:**
- Custom tools (webhook, script, static)
- Custom agents (user-defined prompts, phases)
- Regex scripts (text transformations)
- Plugin-like architecture (add without modifying core)

**Error Handling:**
- Graceful degradation (missing tools, disabled agents)
- Comprehensive logging (Pino logger)
- User-facing error messages (toasts, modals)
- Retry logic (429 rate limits, network errors)

---

## 6. Recommended Patterns for Caretaker Agent

Based on Marinara's architecture, here are recommended patterns for a caretaker agent:

### 6.1 Multi-User State Management

**Pattern:** Zustand store per conversation + shared store for cross-chat state

```typescript
// Per-chat store (existing)
interface ChatStore {
  currentChat: Chat;
  messages: Message[];
  participants: User[];
}

// Cross-chat store (new)
interface CaretakerStore {
  sharedKnowledge: KnowledgeItem[];
  pendingTasks: Task[];
  userRelationships: Relationship[];
  importanceScores: Map<string, number>;
}
```

### 6.2 Agent Pipeline Extensions

**New Agents for Caretaker Use Case:**

1. **Cross-Chat Context Agent** (pre-generation)
   - Queries shared knowledge relevant to current conversation
   - Injects pending tasks for current user
   - Returns: `context_injection` result

2. **Privacy Classifier Agent** (post-processing)
   - Analyzes response for privacy level (public/private/explicit)
   - Extracts knowledge items for storage
   - Returns: `privacy_classification` result

3. **Task Router Agent** (parallel)
   - Detects relay requests, reminders
   - Creates tasks with target chat IDs
   - Returns: `task_routing` result

4. **Relationship Tracker Agent** (parallel)
   - Updates user-to-user relationship state
   - Tracks interaction frequency, sentiment
   - Returns: `relationship_update` result

**Batching Strategy:**
- Batch all read-only agents (shared knowledge, relationship queries)
- Run task creation agents individually (may need tool calls)

### 6.3 Tool System Extensions

**New Tools for Caretaker:**

1. **create_relay_task** - Create message relay task
   ```typescript
   {
     name: "create_relay_task",
     parameters: {
       targetUser: string,
       message: string,
       priority: "low" | "normal" | "high"
     }
   }
   ```

2. **query_shared_knowledge** - Search cross-chat knowledge
   ```typescript
   {
     name: "query_shared_knowledge",
     parameters: {
       query: string,
       visibleToUsers: string[]
     }
   }
   ```

3. **check_pending_tasks** - Get tasks for current user
   ```typescript
   {
     name: "check_pending_tasks",
     parameters: {
       userId: string,
       limit: number
     }
   }
   ```

### 6.4 UI Components

**New Panels:**

1. **Users Panel** - Manage users and relationships
2. **Shared Knowledge Panel** - Cross-chat knowledge base
3. **Tasks Panel** - Pending relays, reminders

**New Widgets (Roleplay HUD):**

1. **Relationship Graph** - Visual user connections
2. **Task Queue** - Pending tasks for current user
3. **Shared Context** - Active cross-chat knowledge

### 6.5 Database Schema Extensions

**New Tables:**

```sql
-- Shared knowledge (cross-chat)
CREATE TABLE shared_knowledge (
  id TEXT PRIMARY KEY,
  content TEXT,
  embedding TEXT,           -- JSON array
  visibility TEXT,          -- JSON array of user IDs or "global"
  importance REAL,
  sourceChat TEXT,
  createdAt TEXT,
  lastAccessedAt TEXT
);

-- Task memory (cross-chat)
CREATE TABLE task_memory (
  id TEXT PRIMARY KEY,
  type TEXT,                -- relay_message, reminder, etc.
  sourceChat TEXT,
  targetChat TEXT,
  content TEXT,
  priority TEXT,
  status TEXT,              -- pending, delivered, completed
  dueAt TEXT,
  createdAt TEXT,
  deliveredAt TEXT
);

-- User relationships
CREATE TABLE user_relationships (
  id TEXT PRIMARY KEY,
  userAId TEXT,
  userBId TEXT,
  relationshipType TEXT,   -- friend, family, etc.
  strength REAL,            -- 0-1 score
  lastInteraction TEXT,
  createdAt TEXT
);
```

---

**End of Document**
