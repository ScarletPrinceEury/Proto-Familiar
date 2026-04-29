# Marinara Engine Memory System - Technical Research

**Repository**: [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine)  
**Version Analyzed**: v1.5.6 (April 2026)  
**Research Date**: April 29, 2026

## Executive Summary

Marinara Engine is a local AI chat/roleplay/game engine that allows characters to maintain continuity across three different interaction modes: Conversation (Discord-style), Roleplay (immersive), and Game (GM-led adventures). The "overarching memory" system doesn't use a traditional global knowledge base. Instead, it employs **three distinct memory types** that work together:

1. **Semantic Memory** - Per-chat message history with embeddings for contextual recall
2. **Character Identity Persistence** - Character data stored separately and shared across chats
3. **Agent Persistent Memory** - Per-agent, per-chat key-value storage for stateful agents

This research documents the technical implementation and architectural patterns.

---

## 1. Database Schema

### 1.1 Memory Chunks Table (Semantic Memory)

**Location**: `packages/server/src/db/schema/chats.ts`

```typescript
export const memoryChunks = sqliteTable("memory_chunks", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").references(() => chats.id, { onDelete: "cascade" }),
  content: text("content").notNull(),      // "Name: message\n\nName: message..."
  embedding: text("embedding"),            // JSON-serialized float[] vector
  messageCount: integer("message_count").notNull(), // Always 5 messages per chunk
  firstMessageAt: text("first_message_at").notNull(),
  lastMessageAt: text("last_message_at").notNull(),
  createdAt: text("created_at").notNull(),
});
```

**Design Principles**:
- Messages grouped into chunks of exactly **5 messages**
- Each chunk embedded using local `all-MiniLM-L6-v2` model (384-dimensional vectors)
- Embeddings stored as JSON arrays in SQLite text column
- Chunks linked to specific chats (per-chat semantic memory)

### 1.2 Agent Memory Table (Persistent State)

**Location**: `packages/server/src/db/schema/agents.ts`

```typescript
export const agentMemory = sqliteTable("agent_memory", {
  id: text("id").primaryKey(),
  agentConfigId: text("agent_config_id").references(() => agentConfigs.id),
  chatId: text("chat_id").notNull(),
  key: text("key").notNull(),              // Memory key identifier
  value: text("value").notNull(),          // JSON-serializable value
  updated_at: text("updated_at").notNull(),
});
```

**Design Principles**:
- Key-value store scoped to (agent, chat) pair
- Agents can store arbitrary JSON data
- Survives message edits and generation retries
- Used for narrative arcs, plot tracking, game state

### 1.3 Chats Table (Core Structure)

**Location**: `packages/server/src/db/schema/chats.ts`

```typescript
export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mode: text("mode", { 
    enum: ["conversation", "roleplay", "visual_novel", "game"] 
  }).notNull(),
  characterIds: text("character_ids").default("[]").notNull(), // JSON array
  groupId: text("group_id"),               // Links related chats (e.g., game sessions)
  personaId: text("persona_id"),           // User persona reference
  connectedChatId: text("connected_chat_id"), // Link between conversation/roleplay
  metadata: text("metadata").default("{}").notNull(), // JSON extended data
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

**Key Patterns**:
- `characterIds`: Array of character IDs (same character can appear in multiple chats)
- `groupId`: Groups multiple chats together (used for game session continuity)
- `metadata`: JSON blob for mode-specific extended data

### 1.4 Chat Metadata Structure

**Location**: `packages/shared/src/types/chat.ts`

```typescript
export interface ChatMetadata {
  // Game Mode continuity
  gameId?: string;
  gameSessionNumber?: number;
  gameSessionStatus?: "setup" | "active" | "concluded";
  gamePreviousSessionSummaries?: SessionSummary[];
  gameStoryArc?: string;                  // GM-only narrative arc
  gamePlotTwists?: string[];              // GM-only planned twists
  gamePartyCharacterIds?: string[];       // Characters in current party
  
  // Conversation mode summaries
  daySummaries?: Record<string, DaySummaryEntry>; // Auto-generated daily recaps
  
  // Memory system toggles
  memoryRecallEnabled?: boolean;
}

export interface SessionSummary {
  sessionNumber: number;
  status: "active" | "concluded";
  concludedAt: string;
  summary: string;                        // Narrative recap for next session
  keyDetails: string[];                   // Facts characters must remember
  storyArc?: string;
  plotTwists?: string[];
  partyArcs?: PartyArc[];
  morale?: number;
}
```

---

## 2. Memory Types and Implementation

### 2.1 Type 1: Semantic Memory (Per-Chat)

**Scope**: Single chat only  
**Implementation**: `packages/server/src/services/memory-recall.ts`

#### Chunking Strategy

```typescript
const CHUNK_SIZE = 5; // Messages per chunk

// Messages formatted as:
const chunkContent = messages
  .map(m => `${m.authorName}: ${m.content}`)
  .join('\n\n');
```

#### Embedding Generation

- **Model**: `all-MiniLM-L6-v2` (sentence-transformers)
- **Dimensions**: 384
- **Runtime**: Local inference (no API calls)
- **Storage**: JSON-serialized float arrays

#### Semantic Search Implementation

```typescript
export async function recallMemories(
  db: DB,
  query: string,
  chatIds: string[],                     // Can search multiple chats
  topK: number = DEFAULT_TOP_K,          // Returns top 8 by default
): Promise<RecalledMemory[]> {
  // 1. Embed query
  const queryEmbedding = await embedText(query);
  
  // 2. Fetch all chunks for target chats
  const chunks = await db
    .select()
    .from(memoryChunks)
    .where(inArray(memoryChunks.chatId, chatIds));
  
  // 3. Calculate cosine similarity
  const scored = chunks.map(chunk => ({
    ...chunk,
    score: cosineSimilarity(queryEmbedding, JSON.parse(chunk.embedding)),
  }));
  
  // 4. Filter and sort
  return scored
    .filter(c => c.score >= SIMILARITY_THRESHOLD) // 0.25 threshold
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
```

#### Configuration Constants

```typescript
const CHUNK_SIZE = 5;                    // Messages per chunk
const SIMILARITY_THRESHOLD = 0.25;       // Minimum score to include
const DEFAULT_TOP_K = 8;                 // Max memories per generation
```

**Pros**:
- Detailed, semantically-aware conversation history
- No token limit constraints (summarized via chunking)
- Automatic embedding updates

**Cons**:
- Per-chat scope (doesn't cross chat boundaries)
- Requires local embedding model
- Storage scales with message count

---

### 2.2 Type 2: Character Identity Persistence

**Scope**: Global (same character data across all chats)  
**Implementation**: Character Card V2 format

#### Character Data Structure

**Location**: `packages/shared/src/types/character.ts`

```typescript
export interface Character {
  id: string;                            // Global character ID
  data: CharacterData;                   // V2 spec (JSON string in DB)
  comment: string;                       // User note for disambiguation
  avatarPath: string | null;
  spriteFolderPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterData {
  name: string;
  description: string;                   // Core identity
  personality: string;                   // Behavioral traits
  scenario: string;                      // Context setting
  appearance: string;
  backstory: string;
  first_mes: string;                     // First message template
  mes_example: string;                   // Example dialogue
  tags: string[];
  extensions: CharacterExtensions;
  character_book: CharacterBook | null;  // Lorebook
}

export interface CharacterExtensions {
  talkativeness: number;                 // 0.0-1.0
  fav: boolean;
  world: string;
  depth_prompt: DepthPrompt;
  backstory: string;                     // Marinara-specific
  appearance: string;                    // Marinara-specific
  rpgStats?: RPGStatsConfig;             // Game mode stats
  conversationStatus?: "online" | "idle" | "dnd" | "offline";
}
```

#### Cross-Chat Reference Pattern

```typescript
// Chats reference characters by ID (not embedding character data)
const chat = {
  characterIds: ["char-123", "char-456"], // JSON array in DB
  // ...
};

// Characters loaded dynamically at generation time
const character = await characters.getById("char-123");
const characterData = JSON.parse(character.data);
```

**Key Insight**: Character data is **read-only** during chat generation. No per-chat character state exists. This ensures consistent character identity across all modes and chats.

---

### 2.3 Type 3: Agent Persistent Memory

**Scope**: Per-agent, per-chat key-value store  
**Implementation**: `packages/server/src/routes/agents.routes.ts`

#### CRUD Operations

```typescript
// Set memory value
export async function setMemory(
  agentConfigId: string,
  chatId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const id = `${agentConfigId}-${chatId}-${key}`;
  await db.insert(agentMemory).values({
    id,
    agentConfigId,
    chatId,
    key,
    value: JSON.stringify(value),
    updated_at: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: agentMemory.id,
    set: {
      value: JSON.stringify(value),
      updated_at: new Date().toISOString(),
    },
  });
}

// Get memory value
export async function getMemory(
  agentConfigId: string,
  chatId: string,
  key: string,
): Promise<unknown | null> {
  const id = `${agentConfigId}-${chatId}-${key}`;
  const row = await db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.id, id))
    .limit(1);
  
  return row[0] ? JSON.parse(row[0].value) : null;
}

// Clear all agent memory for a chat
export async function clearMemoryForChat(
  agentConfigId: string,
  chatId: string,
): Promise<void> {
  await db
    .delete(agentMemory)
    .where(
      and(
        eq(agentMemory.agentConfigId, agentConfigId),
        eq(agentMemory.chatId, chatId),
      ),
    );
}
```

#### Example: Secret Plot Driver Agent

The `secret-plot-driver` agent stores narrative state:

```typescript
interface PlotMemory {
  overarchingArc: string;                // Main story arc
  protagonistArc: string;                // Player's personal growth
  completed: boolean;
  sceneDirections: Array<{
    direction: string;
    fulfilled: boolean;
  }>;
  pacing: "slow" | "exploration" | "building" | "climactic";
}

// Stored as:
await setMemory(
  "secret-plot-driver",
  chatId,
  "plotState",
  plotMemory,
);
```

**Use Cases**:
- Narrative continuity (plot arcs, scene directions)
- Quest tracking (objectives, completion status)
- Combat state (turn order, HP, conditions)
- World state (weather, time, locations)

---

## 3. Character-to-Character Memory System

**Location**: `packages/server/src/db/seed-mari.ts`

Marinara includes a specialized memory format for cross-character communication:

```
[memory: target="CharacterName", summary="what happened between us"]
```

**Characteristics**:
- **Duration**: 24 hours (temporary) or permanent for scene memories
- **Scope**: Between any two characters
- **Storage**: In character extensions (not in chat messages)
- **Use Case**: Character A in conversation mode can reference what happened with Character B in roleplay mode

**Example**:
```
Mari in conversation chat: 
"Hey, I heard from Alex that you completed that quest!"

[memory: target="Alex", summary="User mentioned completing the dragon quest in our roleplay session"]
```

This is the closest Marinara comes to "cross-chat continuity" but it's limited to character-to-character communication rather than full memory sharing.

---

## 4. Cross-Mode Continuity Patterns

### 4.1 Game Mode Session Continuity

**Implementation**: `packages/server/src/routes/game.routes.ts`

Game mode demonstrates the most sophisticated cross-session memory:

```typescript
// Creating a new session in an existing game
sessionChat = await chats.create({
  name: name || "New Game Session",
  mode: "game",
  characterIds: setupConfig.partyCharacterIds,
  groupId: gameId,                       // Links all sessions together
  personaId: setupConfig.personaId ?? null,
  metadata: {
    gameId,
    gameSessionNumber: previousSessions.length + 1,
    gamePreviousSessionSummaries: previousSummaries, // Carried forward!
  },
});
```

**Session Summary Structure**:

```typescript
export interface SessionSummary {
  sessionNumber: number;
  status: "active" | "concluded";
  concludedAt: string;
  summary: string;                       // Narrative recap
  keyDetails: string[];                  // Must-remember facts
  storyArc?: string;
  plotTwists?: string[];
  partyArcs?: PartyArc[];
  morale?: number;
}
```

**Continuity Flow**:
1. Session N concludes → Summary generated by GM agent
2. Summary stored in chat metadata
3. Session N+1 created with `gamePreviousSessionSummaries` including Session N
4. GM agent receives all previous summaries in context
5. Characters reference past events through summaries

---

### 4.2 Conversation ↔ Roleplay Connection

```typescript
export const chats = sqliteTable("chats", {
  // ...
  connectedChatId: text("connected_chat_id"), // Link between modes
  // ...
});
```

**Pattern**: Conversation and roleplay chats can be explicitly linked, allowing:
- Same character appears in both chats
- User can switch between "talking OOC" (conversation) and "in-scene" (roleplay)
- Semantic memory remains separate per chat

**Limitation**: No automatic memory transfer. The connection is UI/organizational only.

---

## 5. Prompt Assembly and Context Building

**Location**: `packages/server/src/services/prompt/assembler.ts`

Character state is resolved dynamically during each generation:

```typescript
async function resolveCharacterMacroData(
  db: DB,
  characterIds: string[],
): Promise<{
  names: string[];
  profiles: CharacterProfile[];
  primaryFields?: CharacterFields;
}> {
  const names: string[] = [];
  const profiles: CharacterProfile[] = [];
  
  for (const id of characterIds) {
    const row = await chars.getById(id);
    const data = JSON.parse(row.data) as CharacterData;
    
    profiles.push({
      id,
      name: data.name,
      description: data.description,
      personality: data.personality,
      scenario: data.scenario,
      backstory: data.extensions?.backstory,
      appearance: data.extensions?.appearance,
      mesExample: data.mes_example,
    });
    
    names.push(data.name);
  }
  
  return { names, profiles, primaryFields };
}
```

**Macro System**:
- `{{char}}` → Current character name
- `{{persona}}` → User persona name
- `{{scenario}}` → Character scenario field
- `{{description}}` → Character description
- `{{personality}}` → Character personality
- `{{mesExamples}}` → Example dialogue

**Context Injection Order** (typical):
1. System instructions
2. Character profiles (resolved from IDs)
3. Lorebook entries (keyword-triggered)
4. Agent context (from persistent memory)
5. Recalled memories (semantic search)
6. Recent messages (token-limited)
7. Response instructions

---

## 6. Agent Context Structure

**Location**: `packages/shared/src/types/agent.ts`

Each agent receives comprehensive context about the current state:

```typescript
export interface AgentContext {
  chatId: string;
  chatMode: string;                      // "conversation" | "roleplay" | "game"
  recentMessages: ChatMessage[];
  mainResponse: string | null;           // Current generation
  gameState: GameState | null;           // Game mode only
  
  characters: Array<{
    id: string;
    name: string;
    description: string;
    personality?: string;
    extensions?: {
      backstory?: string;
      appearance?: string;
    };
  }>;
  
  memory: Record<string, unknown>;       // Agent's persistent key-value store
  
  persona: {
    name: string;
    description: string;
    personality?: string;
    backstory?: string;
  } | null;
  
  // Agent can request semantic memory recall
  recalledMemories?: RecalledMemory[];
}
```

**Agent Workflow**:
1. Agent receives context with current chat state
2. Agent loads its persistent memory via `getMemory()`
3. Agent processes context and generates output
4. Agent updates persistent memory via `setMemory()`
5. Agent returns instructions/modifications to main generation

---

## 7. Implementation Best Practices

### 7.1 Architectural Patterns

1. **Character Decoupling**
   - Characters stored separately from chats
   - Referenced by ID, not embedded
   - Ensures consistent identity across all contexts

2. **Metadata Pattern**
   - Extended chat data via JSON column
   - Avoids schema migrations for new features
   - Mode-specific data (game state, summaries) in metadata

3. **Agent Isolation**
   - Each agent manages its own memory per chat
   - No cross-chat or cross-agent memory access
   - Prevents unintended side effects

4. **Lazy Loading**
   - Character data loaded at generation time
   - Not stored in chat objects
   - Reduces data duplication

5. **Embedding Optimization**
   - Chunked message history (5 messages per chunk)
   - Similarity-filtered recall (threshold 0.25)
   - Prevents context overflow

6. **Session Continuity**
   - Explicit summary generation
   - Carried forward via metadata
   - No implicit cross-session memory

### 7.2 Memory Scope Design Philosophy

**Key Insight**: Marinara deliberately **avoids global memory sharing**. Each memory type has explicit scope:

| Memory Type | Scope | Persistence | Cross-Chat? |
|-------------|-------|-------------|-------------|
| Semantic Memory | Per-chat | Permanent | No |
| Character Identity | Global | Permanent | Yes (data only) |
| Agent Memory | Per-agent-per-chat | Permanent | No |
| Session Summaries | Per-game-group | Permanent | Yes (explicit) |
| Character-to-Character | Between 2 characters | 24h or scene | Limited |

**Rationale**: Prevents agents from hallucinating cross-chat continuity or accessing irrelevant context. Memory is scoped to its purpose.

---

## 8. Code Organization

### 8.1 Directory Structure

```
packages/
├── server/
│   ├── src/
│   │   ├── db/
│   │   │   ├── schema/
│   │   │   │   ├── chats.ts          # Chat, messages, memory_chunks tables
│   │   │   │   ├── agents.ts         # Agent configs, agent_memory table
│   │   │   │   └── characters.ts     # Characters table
│   │   ├── services/
│   │   │   ├── memory-recall.ts      # Semantic memory (chunking, embeddings)
│   │   │   ├── storage/
│   │   │   │   ├── chats.storage.ts  # Chat CRUD operations
│   │   │   │   ├── characters.storage.ts # Character CRUD operations
│   │   │   │   └── agents.storage.ts # Agent memory CRUD operations
│   │   │   └── prompt/
│   │   │       └── assembler.ts      # Prompt building, macro resolution
│   │   └── routes/
│   │       ├── chats.routes.ts       # Chat API endpoints
│   │       ├── game.routes.ts        # Game mode, session management
│   │       └── agents.routes.ts      # Agent management, memory endpoints
├── shared/
│   ├── src/
│   │   ├── types/
│   │   │   ├── chat.ts               # Chat, ChatMetadata interfaces
│   │   │   ├── character.ts          # Character, CharacterData interfaces
│   │   │   ├── agent.ts              # AgentContext, AgentConfig interfaces
│   │   │   └── game.ts               # GameState, SessionSummary interfaces
│   │   └── constants/
│   │       └── chat-modes.ts         # Mode definitions, default agents
```

### 8.2 Key Files and Responsibilities

| File | Purpose | Key Functions |
|------|---------|---------------|
| `memory-recall.ts` | Semantic memory system | `chunkAndEmbedMessages()`, `recallMemories()` |
| `agents.storage.ts` | Agent memory CRUD | `setMemory()`, `getMemory()`, `clearMemoryForChat()` |
| `characters.storage.ts` | Character management | `getById()`, `create()`, `update()` |
| `chats.storage.ts` | Chat management | `create()`, `update()`, `updateMetadata()` |
| `game.routes.ts` | Game mode logic | Session creation, conclusion, summary generation |
| `assembler.ts` | Prompt building | `resolveCharacterMacroData()`, macro expansion |

---

## 9. Technology Stack

- **Database**: SQLite (via Drizzle ORM)
- **Embedding Model**: `all-MiniLM-L6-v2` (sentence-transformers, local)
- **Vector Storage**: JSON arrays in SQLite text columns
- **Similarity**: Cosine similarity (in-memory calculation)
- **Character Format**: Character Card V2 (community standard)
- **Runtime**: Node.js backend, React frontend

---

## 10. Critical Implementation Details

### 10.1 Chunking Strategy Rationale

**Why 5 messages per chunk?**
- Small enough to be semantically coherent
- Large enough to capture conversation flow
- Balances embedding storage cost vs. granularity
- Reduces total number of chunks (faster search)

### 10.2 Embedding Model Choice

**Why `all-MiniLM-L6-v2`?**
- Fast inference on CPU (no GPU required)
- Small model size (80MB)
- 384 dimensions (good balance of quality vs. size)
- Runs locally (no API calls, privacy-preserving)
- Widely supported by sentence-transformers library

### 10.3 Similarity Threshold

**Why 0.25?**
- Empirically determined through testing
- Captures relevantly related content
- Filters out noise
- Allows 8-16 relevant chunks per query

### 10.4 Agent Memory Persistence

**Why key-value store instead of structured tables?**
- Each agent has unique state structure
- Avoids schema migrations for new agents
- Flexible for experimentation
- JSON serialization handles complex types

---

## 11. Limitations and Trade-offs

1. **No Cross-Chat Semantic Memory**
   - Memory chunks scoped to single chat
   - Characters can't "remember" conversations from other chats
   - Deliberate design to prevent hallucination

2. **Character-to-Character Memory is Limited**
   - 24-hour expiration for most memories
   - Not automatically integrated into prompts
   - Requires explicit [memory: ...] syntax

3. **Agent Memory is Per-Chat**
   - Same agent in different chats has separate memory
   - No shared knowledge across chats
   - Game mode uses explicit linking via groupId

4. **Embedding Storage in SQLite**
   - No specialized vector database (pgvector, Pinecone, etc.)
   - In-memory cosine similarity (scales to ~10K chunks)
   - Trade-off: simplicity vs. scale

5. **No Memory Compression**
   - Chunks accumulate indefinitely
   - No automatic summarization or pruning
   - Database can grow large over time

---

## 12. Key Takeaways for Implementation

### ✅ Core Patterns to Adopt

1. **Three-Tier Memory Architecture**
   - Semantic (per-context detailed history)
   - Identity (shared static data)
   - Persistent state (stateful key-value)

2. **Chunking + Embeddings for Recall**
   - Group messages into semantic units
   - Use local embedding model for privacy
   - Store vectors as JSON in SQLite for simplicity

3. **Reference-by-ID Pattern**
   - Store entity IDs, not full data
   - Load dynamically at runtime
   - Ensures consistency across contexts

4. **JSON Metadata Column**
   - Flexible extension without migrations
   - Mode-specific or context-specific data
   - Easy to query and update

5. **Explicit Cross-Context Linking**
   - Use `groupId` for related sessions
   - Store summaries in metadata
   - No implicit memory sharing

### ⚠️ Design Decisions to Consider

1. **Scope Control is Critical**
   - Marinara deliberately limits cross-chat access
   - Prevents hallucination and context bleeding
   - For multi-user scenarios, you'll need explicit sharing

2. **Embedding Model Trade-offs**
   - Local = privacy, no API costs, CPU inference
   - Cloud = better quality, API costs, faster (GPU)
   - Choose based on privacy/performance needs

3. **Storage Scaling**
   - SQLite works well up to ~10K chats
   - Beyond that, consider PostgreSQL + pgvector
   - Or dedicated vector DB (Pinecone, Weaviate)

4. **Memory Lifecycle**
   - Marinara has no pruning/compression
   - Consider importance decay over time
   - Implement summarization for old context

---

## 13. Conclusion

Marinara Engine achieves "overarching memory" not through a global shared knowledge base, but through **three complementary memory systems** with explicit scopes:

1. **Semantic Memory** provides detailed conversation history within each chat
2. **Character Identity** ensures consistent character behavior across all modes
3. **Agent Memory** enables stateful, context-aware AI agents

The design philosophy prioritizes **scoped, purpose-driven memory** over global access. This prevents hallucination and maintains clear boundaries between different interaction contexts.

For building a caretaker agent that needs to share information across multiple user chats, Marinara's architecture provides excellent foundational patterns but will require extension beyond its deliberately limited cross-chat capabilities.

---

## References

- [Marinara Engine Repository](https://github.com/Pasta-Devs/Marinara-Engine)
- [Character Card V2 Specification](https://github.com/malfoyslastname/character-card-spec-v2)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [sentence-transformers Library](https://www.sbert.net/)
