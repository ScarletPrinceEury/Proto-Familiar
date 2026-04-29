# Applying Marinara's Memory Architecture to a Caretaker Agent

**Context**: Building an AI agent that maintains conversations with multiple people across different chats while having enough continuity to pass information between them (e.g., relay message from Person A to Person B in different chats).

**Challenge**: Marinara Engine deliberately avoids cross-chat memory sharing, but our use case explicitly requires it.

---

## 1. Core Architectural Differences

| Aspect | Marinara Engine | Caretaker Agent (Required) |
|--------|----------------|---------------------------|
| **Primary Use Case** | Single user, multiple characters, multiple modes | Single agent, multiple users, multiple chats |
| **Memory Philosophy** | Scoped memory prevents hallucination | Selective cross-chat knowledge sharing |
| **Entity Type** | Multiple characters (passive data) | Single agent (active, autonomous) |
| **Cross-Chat Sharing** | Deliberately limited to character identity only | Explicit message passing and relationship tracking |
| **Privacy Concern** | Not relevant (single user) | Critical (multiple users) |

---

## 2. Recommended Architecture

### 2.1 Three-Tier Memory System (Adapted from Marinara)

#### Tier 1: Per-Chat Memory (KEEP - Marinara Pattern)

**Purpose**: Conversation history with specific user  
**Scope**: Single chat  
**Implementation**: Identical to Marinara's semantic memory

```typescript
interface PerChatMemory {
  chatId: string;
  userId: string;
  chunks: MemoryChunk[];              // 5-message chunks with embeddings
}

interface MemoryChunk {
  id: string;
  chatId: string;
  content: string;                    // "Agent: ...\nUser: ..."
  embedding: number[];                // 384-dim vector (all-MiniLM-L6-v2)
  messageCount: number;               // Always 5
  firstMessageAt: string;
  lastMessageAt: string;
}
```

**Why Keep This**: 
- Provides detailed context for ongoing conversations
- Semantic search within chat history
- Private conversation details stay scoped to that chat

**Implementation Reference**: See Marinara's `memory-recall.ts`

---

#### Tier 2: Shared Agent Knowledge (NEW - Core Extension)

**Purpose**: Information the agent knows across all chats  
**Scope**: Global with visibility controls  
**Implementation**: NEW capability beyond Marinara

```typescript
interface SharedKnowledge {
  id: string;
  category: "user_info" | "relationship" | "task" | "fact" | "preference";
  content: string;
  embedding: number[];                // For semantic search
  sourceChats: string[];              // Which chats contributed this
  visibility: "global" | string[];    // "global" or specific chat IDs
  createdAt: string;
  lastAccessedAt: string;
  importance: number;                 // 0.0-1.0 (for prioritization)
  privacyLevel: "public" | "private" | "explicit"; // Privacy classification
}
```

**Examples**:
```typescript
// General fact - visible everywhere
{ 
  category: "user_info", 
  content: "Alice prefers cats over dogs", 
  visibility: "global",
  privacyLevel: "public",
  importance: 0.4
}

// Cross-chat task - visible to specific chats only
{ 
  category: "task", 
  content: "Bob asked me to remind Alice about the meeting", 
  visibility: ["chat-alice", "chat-bob"],
  privacyLevel: "explicit",
  importance: 0.9
}

// Relationship info - visible globally
{ 
  category: "relationship", 
  content: "Alice and Bob are siblings", 
  visibility: "global",
  privacyLevel: "public",
  importance: 0.7
}
```

**Key Differences from Marinara**:
- Not character data (agent's own knowledge base)
- Can be scoped to specific chats for privacy
- Supports cross-chat semantic queries
- Has importance weighting for prioritization
- Privacy-aware visibility controls

---

#### Tier 3: Task Memory (NEW - Agent Action System)

**Purpose**: Pending actions, reminders, message relay  
**Scope**: Global (but can target specific chats)  
**Implementation**: Extend Marinara's agent memory pattern

```typescript
interface TaskMemory {
  id: string;
  type: "reminder" | "follow_up" | "relay_message" | "pending_action";
  sourceChat: string;
  sourcePerson: string;
  targetChat: string | null;          // For cross-chat tasks
  targetPerson: string | null;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  content: string;
  priority: "low" | "medium" | "high" | "urgent";
  metadata: Record<string, unknown>;
  createdAt: string;
  dueAt: string | null;
  completedAt: string | null;
}
```

**Examples**:
```typescript
// Relay message between users
{
  type: "relay_message",
  sourceChat: "chat-alice",
  sourcePerson: "Alice",
  targetChat: "chat-bob",
  targetPerson: "Bob",
  content: "Tell Bob about the party on Saturday at 7pm",
  priority: "medium",
  status: "pending"
}

// Self reminder within chat
{
  type: "reminder",
  sourceChat: "chat-bob",
  sourcePerson: "Bob",
  targetChat: "chat-bob",
  targetPerson: "Bob",
  content: "Remind about dentist appointment tomorrow at 2pm",
  priority: "high",
  dueAt: "2026-04-30T14:00:00Z",
  status: "pending"
}

// Follow-up action
{
  type: "follow_up",
  sourceChat: "chat-alice",
  sourcePerson: "Alice",
  targetChat: "chat-alice",
  targetPerson: "Alice",
  content: "Check if Alice heard back about the job application",
  priority: "low",
  dueAt: "2026-05-02T09:00:00Z",
  status: "pending"
}
```

---

### 2.2 Database Schema

Extend Marinara's schema with new tables:

```sql
-- KEEP: Marinara's memory_chunks table (per-chat semantic memory)
CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding TEXT NOT NULL,              -- JSON array of floats
  message_count INTEGER NOT NULL,
  first_message_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_memory_chunks_chat ON memory_chunks(chat_id);

-- NEW: Shared agent knowledge (cross-chat facts)
CREATE TABLE shared_knowledge (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('user_info', 'relationship', 'task', 'fact', 'preference')),
  content TEXT NOT NULL,
  embedding TEXT NOT NULL,              -- JSON array of floats
  source_chats TEXT NOT NULL,           -- JSON array of chat IDs
  visibility TEXT NOT NULL,             -- "global" or JSON array of chat IDs
  privacy_level TEXT NOT NULL DEFAULT 'public' CHECK(privacy_level IN ('public', 'private', 'explicit')),
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0.0 AND importance <= 1.0)
);

CREATE INDEX idx_shared_knowledge_category ON shared_knowledge(category);
CREATE INDEX idx_shared_knowledge_importance ON shared_knowledge(importance);

-- NEW: Cross-chat task tracking
CREATE TABLE task_memory (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('reminder', 'follow_up', 'relay_message', 'pending_action')),
  source_chat TEXT NOT NULL REFERENCES chats(id),
  source_person TEXT NOT NULL REFERENCES users(id),
  target_chat TEXT REFERENCES chats(id),
  target_person TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at TEXT NOT NULL,
  due_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_task_memory_status ON task_memory(status);
CREATE INDEX idx_task_memory_target ON task_memory(target_chat, status);
CREATE INDEX idx_task_memory_due ON task_memory(due_at) WHERE due_at IS NOT NULL;

-- NEW: User profiles (multi-user tracking)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  preferences TEXT DEFAULT '{}',        -- JSON
  relationship_to_agent TEXT,           -- "friend", "family", "professional", etc.
  created_at TEXT NOT NULL,
  last_interaction_at TEXT
);

-- NEW: User relationships (for context)
CREATE TABLE user_relationships (
  id TEXT PRIMARY KEY,
  user_a_id TEXT NOT NULL REFERENCES users(id),
  user_b_id TEXT NOT NULL REFERENCES users(id),
  relationship_type TEXT NOT NULL,      -- "sibling", "coworker", "friend", etc.
  context TEXT,                         -- Additional context
  created_at TEXT NOT NULL,
  UNIQUE(user_a_id, user_b_id)
);

-- MODIFY: Extend chats table
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT DEFAULT '{}'            -- JSON for extended data
);

CREATE INDEX idx_chats_user ON chats(user_id);
```

---

## 3. Core Implementation Patterns

### 3.1 Explicit Message Relay Pattern

**Use Case**: "Tell Bob that I'll be late for the meeting"

#### Step 1: Parse Relay Request (in Alice's chat)

```typescript
async function handleRelayRequest(
  content: string,
  sourceContext: ChatContext,
  targetPerson: string,
): Promise<string> {
  // 1. Find target chat
  const targetChat = await findChatByUserName(targetPerson);
  if (!targetChat) {
    return `I don't have an active conversation with ${targetPerson} yet.`;
  }
  
  // 2. Create relay task
  const task = await createTask({
    type: "relay_message",
    sourceChat: sourceContext.chatId,
    sourcePerson: sourceContext.userId,
    targetChat: targetChat.id,
    targetPerson: targetChat.userId,
    content: content,
    priority: "medium",
    status: "pending",
  });
  
  // 3. Add to shared knowledge (optional, for context)
  await addSharedKnowledge({
    category: "task",
    content: `Relay from ${sourceContext.userName} to ${targetPerson}: ${content}`,
    visibility: [sourceContext.chatId, targetChat.id],
    privacyLevel: "explicit",
    importance: 0.8,
    sourceChats: [sourceContext.chatId],
  });
  
  // 4. Confirm with Alice
  return `I'll let ${targetPerson} know when I talk to them next.`;
}
```

#### Step 2: Deliver Message (in Bob's chat)

```typescript
async function checkAndDeliverPendingTasks(
  chatContext: ChatContext,
): Promise<string[]> {
  const pendingTasks = await db
    .select()
    .from(taskMemory)
    .where(
      and(
        eq(taskMemory.targetChat, chatContext.chatId),
        eq(taskMemory.status, "pending"),
      ),
    )
    .orderBy(desc(taskMemory.priority), asc(taskMemory.createdAt));
  
  const deliveredMessages: string[] = [];
  
  for (const task of pendingTasks) {
    if (task.type === "relay_message") {
      // Mark as in progress
      await updateTaskStatus(task.id, "in_progress");
      
      // Format message
      const sourcePerson = await getUserById(task.sourcePerson);
      const message = `Hey, ${sourcePerson.name} wanted me to tell you: ${task.content}`;
      
      deliveredMessages.push(message);
      
      // Mark as completed after delivery
      await updateTaskStatus(task.id, "completed", new Date().toISOString());
    }
  }
  
  return deliveredMessages;
}

// Called at start of generation
async function buildAgentContext(chatContext: ChatContext): Promise<string> {
  const parts: string[] = [];
  
  // Check for pending tasks first
  const pendingMessages = await checkAndDeliverPendingTasks(chatContext);
  if (pendingMessages.length > 0) {
    parts.push("PENDING MESSAGES TO DELIVER:");
    parts.push(...pendingMessages);
    parts.push("");
  }
  
  // ... rest of context building
  return parts.join('\n');
}
```

**Complete Flow**:
1. Alice (Chat A): "Tell Bob I'll be late for the meeting"
2. Agent: Parses relay request â†’ Creates `relay_message` task
3. Agent responds: "I'll let Bob know"
4. Bob (Chat B): Starts conversation later
5. Agent: Checks pending tasks for Bob's chat
6. Agent: "Hey Bob, Alice wanted me to tell you: she'll be late for the meeting"
7. Agent: Marks task as completed

---

### 3.2 Shared Context Pattern

**Use Case**: Agent mentions shared context naturally ("I heard about the party from Alice")

#### Context Builder Implementation

```typescript
async function buildContextForGeneration(
  chatContext: ChatContext,
): Promise<string> {
  const parts: string[] = [];
  
  // 1. Per-chat semantic memory (Marinara pattern)
  const recentQuery = chatContext.recentMessages
    .map(m => m.content)
    .join(' ');
    
  const recalled = await recallMemories(
    chatContext.chatId,
    recentQuery,
    8, // top K
  );
  
  if (recalled.length > 0) {
    parts.push("CONVERSATION HISTORY:");
    parts.push(recalled.map(r => r.content).join('\n'));
    parts.push("");
  }
  
  // 2. Shared knowledge visible to this chat (NEW)
  const sharedKnowledge = await querySharedKnowledge(
    recentQuery,
    chatContext.chatId,
    5, // top K
  );
  
  if (sharedKnowledge.length > 0) {
    parts.push("RELEVANT INFORMATION FROM OTHER CONVERSATIONS:");
    parts.push(sharedKnowledge.map(k => {
      const source = k.sourceChats.length > 0 
        ? ` (learned from conversation with ${getSourceNames(k.sourceChats)})`
        : "";
      return `- ${k.content}${source}`;
    }).join('\n'));
    parts.push("");
  }
  
  // 3. User relationship context
  const relationships = await getUserRelationships(chatContext.userId);
  if (relationships.length > 0) {
    parts.push("USER RELATIONSHIPS:");
    parts.push(relationships.map(r => 
      `${r.otherUserName}: ${r.relationshipType}`
    ).join(', '));
    parts.push("");
  }
  
  // 4. Pending tasks
  const tasks = await getPendingTasksForChat(chatContext.chatId);
  if (tasks.length > 0) {
    parts.push("PENDING REMINDERS/MESSAGES:");
    parts.push(tasks.map(t => `- [${t.priority}] ${t.content}`).join('\n'));
    parts.push("");
  }
  
  return parts.join('\n');
}
```

#### Shared Knowledge Query with Privacy Filtering

```typescript
async function querySharedKnowledge(
  query: string,
  chatId: string,
  topK: number,
): Promise<SharedKnowledge[]> {
  // 1. Embed query
  const queryEmbedding = await embedText(query);
  
  // 2. Fetch knowledge visible to this chat
  const allKnowledge = await db
    .select()
    .from(sharedKnowledge)
    .where(
      or(
        eq(sharedKnowledge.visibility, "global"),
        like(sharedKnowledge.visibility, `%"${chatId}"%`), // JSON array contains
      ),
    );
  
  // 3. Calculate similarity Ã— importance score
  const scored = allKnowledge.map(k => ({
    ...k,
    embedding: JSON.parse(k.embedding),
    score: cosineSimilarity(queryEmbedding, JSON.parse(k.embedding)),
  }));
  
  // 4. Filter by relevance and rank by combined score
  return scored
    .filter(k => k.score >= 0.3) // Similarity threshold
    .sort((a, b) => {
      const scoreA = a.score * a.importance;
      const scoreB = b.score * b.importance;
      return scoreB - scoreA;
    })
    .slice(0, topK);
}
```

**Example Scenario**:
```
Alice (Chat A): "I'm throwing a party on Saturday at my place"
â†’ Agent stores: { 
    category: "fact", 
    content: "Alice is throwing a party on Saturday", 
    visibility: "global",
    sourceChats: ["chat-alice"]
  }

Bob (Chat B): "Any plans this weekend?"
â†’ Agent queries shared knowledge
â†’ Finds party info with high relevance
â†’ Agent: "Actually, Alice mentioned she's throwing a party on Saturday. 
          Want me to check if you're invited?"
```

---

### 3.3 Privacy-Preserving Patterns

**Challenge**: Not all information should be shared across chats

#### Privacy Classification System

```typescript
type PrivacyLevel = "public" | "private" | "explicit";

async function classifyInformationPrivacy(
  content: string,
  chatContext: ChatContext,
): Promise<PrivacyLevel> {
  // Use LLM to classify
  const classification = await llm.complete({
    system: `You are a privacy classifier. Analyze if information is:
    
    - public: General facts that can be shared (hobbies, preferences, public events)
    - private: Sensitive information that should never leave this conversation (health, finances, secrets)
    - explicit: Only share if explicitly requested (plans, messages, personal details)
    
    Return only: "public", "private", or "explicit"`,
    user: `Context: User just said this in our conversation:\n"${content}"\n\nClassify the privacy level.`,
  });
  
  return classification.toLowerCase() as PrivacyLevel;
}

// Use during knowledge extraction
async function extractAndStoreKnowledge(
  message: string,
  chatContext: ChatContext,
): Promise<void> {
  // Extract potential knowledge items
  const items = await extractKnowledgeItems(message);
  
  for (const item of items) {
    // Classify privacy
    const privacyLevel = await classifyInformationPrivacy(item.content, chatContext);
    
    // Determine visibility
    let visibility: string | string[];
    if (privacyLevel === "private") {
      continue; // Don't store in shared knowledge
    } else if (privacyLevel === "explicit") {
      visibility = [chatContext.chatId]; // Only this chat initially
    } else {
      visibility = "global"; // Can be accessed by all chats
    }
    
    await addSharedKnowledge({
      category: item.category,
      content: item.content,
      embedding: await embedText(item.content),
      sourceChats: [chatContext.chatId],
      visibility,
      privacyLevel,
      importance: item.importance,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    });
  }
}
```

#### Explicit Consent Pattern

```typescript
// When agent wants to share ambiguous information
async function requestSharingConsent(
  content: string,
  sourceUser: string,
  targetUser: string,
  sourceChat: string,
): Promise<boolean> {
  // Store pending consent request
  const consentRequest = await db.insert(consentRequests).values({
    id: generateId(),
    content,
    sourceUser,
    targetUser,
    sourceChat,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  
  // Ask in the next message generation
  // "You mentioned X earlier. Is it okay if I share this with [target]?"
  
  // Implementation depends on your message flow
  // Could be immediate follow-up or check on next interaction
  
  return false; // Default to no until confirmed
}

// Check consent before sharing
async function canShareKnowledge(
  knowledgeId: string,
  targetChatId: string,
): Promise<boolean> {
  const knowledge = await getSharedKnowledgeById(knowledgeId);
  
  // Check visibility
  if (knowledge.visibility === "global") {
    return true;
  }
  
  if (Array.isArray(knowledge.visibility)) {
    return knowledge.visibility.includes(targetChatId);
  }
  
  return false;
}
```

---

## 4. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)

**Goal**: Implement Marinara's core patterns

```typescript
// Tasks to complete:
// 1. Database setup
//    - Create SQLite database
//    - Implement schema (memory_chunks, chats, users)
//    - Set up Drizzle ORM

// 2. Per-chat memory system
//    - Message chunking (5 per chunk)
//    - Embedding generation (all-MiniLM-L6-v2)
//    - Cosine similarity search
//    - recallMemories() function

// 3. Basic chat management
//    - Create/update chats
//    - Link chats to users
//    - Message storage

// 4. User management
//    - User profiles
//    - Basic metadata
```

**Validation**: Agent can maintain separate conversations with 2+ users, recalling context within each chat.

---

### Phase 2: Cross-Chat Extensions (Weeks 3-4)

**Goal**: Add cross-chat capabilities beyond Marinara

```typescript
// Tasks to complete:
// 1. Shared knowledge system
//    - Add shared_knowledge table
//    - Implement knowledge extraction from messages
//    - Privacy classification (LLM-based)
//    - Visibility controls
//    - querySharedKnowledge() function

// 2. Task memory
//    - Add task_memory table
//    - Task creation/update/completion
//    - Priority and scheduling
//    - checkPendingTasks() function

// 3. Context builder
//    - Integrate per-chat memory (Phase 1)
//    - Add shared knowledge injection
//    - Add pending task injection
//    - Privacy filtering
```

**Validation**: Agent can relay messages between users and reference shared context appropriately.

---

### Phase 3: Advanced Features (Weeks 5-6)

**Goal**: Polish and enhance

```typescript
// Tasks to complete:
// 1. Relationship tracking
//    - User-to-user relationships
//    - Relationship-aware sharing
//    - Context enrichment

// 2. Privacy enhancements
//    - Consent management
//    - Privacy policy per user
//    - Audit log for cross-chat access

// 3. Memory management
//    - Importance decay over time
//    - Memory consolidation
//    - Automatic summarization
//    - Storage cleanup

// 4. Task scheduling
//    - Time-based reminders
//    - Follow-up tracking
//    - Proactive task completion
```

**Validation**: Agent handles complex multi-user scenarios with appropriate privacy and context.

---

## 5. Code Structure Recommendation

```
src/
â”œâ”€â”€ db/
â”‚   â”œâ”€â”€ schema/
â”‚   â”‚   â”œâ”€â”€ users.ts              # User profiles, relationships
â”‚   â”‚   â”œâ”€â”€ chats.ts              # Chats, memory_chunks
â”‚   â”‚   â”œâ”€â”€ knowledge.ts          # shared_knowledge table
â”‚   â”‚   â””â”€â”€ tasks.ts              # task_memory table
â”‚   â””â”€â”€ migrations/               # Database migrations
â”‚
â”œâ”€â”€ services/
â”‚   â”œâ”€â”€ memory/
â”‚   â”‚   â”œâ”€â”€ per-chat.ts           # Marinara's semantic memory
â”‚   â”‚   â”œâ”€â”€ shared-knowledge.ts   # Cross-chat knowledge
â”‚   â”‚   â”œâ”€â”€ tasks.ts              # Task memory system
â”‚   â”‚   â””â”€â”€ embeddings.ts         # Embedding generation
â”‚   â”‚
â”‚   â”œâ”€â”€ privacy/
â”‚   â”‚   â”œâ”€â”€ classifier.ts         # Privacy level classification
â”‚   â”‚   â”œâ”€â”€ consent.ts            # Consent management
â”‚   â”‚   â””â”€â”€ visibility.ts         # Visibility control logic
â”‚   â”‚
â”‚   â”œâ”€â”€ context/
â”‚   â”‚   â”œâ”€â”€ builder.ts            # Context assembly for generation
â”‚   â”‚   â”œâ”€â”€ retrieval.ts          # Memory retrieval orchestration
â”‚   â”‚   â””â”€â”€ filtering.ts          # Privacy filtering
â”‚   â”‚
â”‚   â””â”€â”€ relationships/
â”‚       â”œâ”€â”€ tracker.ts            # User relationship management
â”‚       â””â”€â”€ graph.ts              # Relationship graph queries
â”‚
â”œâ”€â”€ routes/
â”‚   â”œâ”€â”€ chats.ts                  # Chat CRUD operations
â”‚   â”œâ”€â”€ users.ts                  # User management
â”‚   â”œâ”€â”€ knowledge.ts              # Knowledge API
â”‚   â””â”€â”€ tasks.ts                  # Task management
â”‚
â””â”€â”€ utils/
    â”œâ”€â”€ similarity.ts             # Cosine similarity (Marinara)
    â””â”€â”€ ids.ts                    # ID generation
```

---

## 6. Critical Implementation Considerations

### 6.1 Privacy by Default

```typescript
// Default to most restrictive
const DEFAULT_PRIVACY = "private";
const DEFAULT_VISIBILITY = []; // Empty array = no chats

// Always require explicit visibility extension
async function extendVisibility(
  knowledgeId: string,
  newChatIds: string[],
  requestingUser: string,
): Promise<boolean> {
  const knowledge = await getSharedKnowledgeById(knowledgeId);
  
  // Check if requesting user has permission
  if (!knowledge.sourceChats.includes(requestingUser)) {
    return false; // Can't share what you didn't contribute to
  }
  
  // Update visibility
  const currentVisibility = knowledge.visibility === "global" 
    ? "global" 
    : JSON.parse(knowledge.visibility);
    
  if (currentVisibility === "global") {
    return true; // Already global
  }
  
  const updatedVisibility = [...new Set([...currentVisibility, ...newChatIds])];
  
  await updateSharedKnowledge(knowledgeId, {
    visibility: JSON.stringify(updatedVisibility),
  });
  
  return true;
}
```

### 6.2 Importance Decay Over Time

```typescript
// Implement time-based importance decay
async function decayImportance(): Promise<void> {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  
  const allKnowledge = await db.select().from(sharedKnowledge);
  
  for (const item of allKnowledge) {
    const age = now - new Date(item.lastAccessedAt).getTime();
    const daysSinceAccess = age / oneDayMs;
    
    // Decay formula: importance * exp(-0.01 * days)
    // After 100 days: ~37% of original importance
    const decayFactor = Math.exp(-0.01 * daysSinceAccess);
    const newImportance = Math.max(0.1, item.importance * decayFactor);
    
    if (Math.abs(newImportance - item.importance) > 0.05) {
      await db.update(sharedKnowledge)
        .set({ importance: newImportance })
        .where(eq(sharedKnowledge.id, item.id));
    }
  }
}

// Run periodically (e.g., daily cron job)
```

### 6.3 Knowledge Extraction from Messages

```typescript
async function extractKnowledgeItems(
  message: string,
  chatContext: ChatContext,
): Promise<KnowledgeItem[]> {
  const extraction = await llm.complete({
    system: `Extract factual information from the message.
    
    Return JSON array of items with:
    - category: "user_info" | "relationship" | "fact" | "preference"
    - content: The extracted fact (concise, <100 chars)
    - importance: 0.0-1.0 (how important is this information?)
    
    Only extract information that would be useful to remember in future conversations.
    Do not extract temporary or trivial information.`,
    user: message,
    responseFormat: { type: "json_object" },
  });
  
  const items = JSON.parse(extraction);
  
  // Filter and validate
  return items
    .filter(item => item.content.length > 10 && item.content.length < 200)
    .map(item => ({
      category: item.category,
      content: item.content,
      importance: Math.max(0.1, Math.min(1.0, item.importance)),
    }));
}
```

### 6.4 Task Priority and Scheduling

```typescript
interface TaskSchedule {
  dueAt: string | null;
  priority: "low" | "medium" | "high" | "urgent";
}

function calculateTaskPriority(
  task: TaskMemory,
  currentTime: Date,
): number {
  // Base priority
  const priorityScores = {
    urgent: 100,
    high: 75,
    medium: 50,
    low: 25,
  };
  
  let score = priorityScores[task.priority];
  
  // Increase priority as due date approaches
  if (task.dueAt) {
    const dueDate = new Date(task.dueAt);
    const timeUntilDue = dueDate.getTime() - currentTime.getTime();
    const hoursUntilDue = timeUntilDue / (1000 * 60 * 60);
    
    if (hoursUntilDue < 0) {
      score += 50; // Overdue
    } else if (hoursUntilDue < 1) {
      score += 40; // Due within 1 hour
    } else if (hoursUntilDue < 24) {
      score += 20; // Due within 24 hours
    }
  }
  
  // Increase priority for older tasks
  const age = currentTime.getTime() - new Date(task.createdAt).getTime();
  const daysOld = age / (1000 * 60 * 60 * 24);
  score += Math.min(25, daysOld * 2); // Up to +25 for old tasks
  
  return score;
}

async function getPrioritizedTasks(
  targetChatId: string,
): Promise<TaskMemory[]> {
  const tasks = await db
    .select()
    .from(taskMemory)
    .where(
      and(
        eq(taskMemory.targetChat, targetChatId),
        eq(taskMemory.status, "pending"),
      ),
    );
  
  const now = new Date();
  
  return tasks
    .map(task => ({
      ...task,
      priorityScore: calculateTaskPriority(task, now),
    }))
    .sort((a, b) => b.priorityScore - a.priorityScore);
}
```

---

## 7. Testing Strategy

### 7.1 Unit Tests

```typescript
// Test per-chat memory isolation
describe("Per-Chat Memory", () => {
  test("memories are scoped to specific chat", async () => {
    // Store messages in chat A
    await storeMessage(chatA, "Secret information A");
    
    // Query from chat B
    const results = await recallMemories(chatB, "secret", 10);
    
    expect(results).toHaveLength(0); // Should not access chat A's memory
  });
});

// Test shared knowledge visibility
describe("Shared Knowledge", () => {
  test("respects visibility controls", async () => {
    // Create knowledge visible only to chat A
    await addSharedKnowledge({
      content: "Private fact",
      visibility: [chatA.id],
    });
    
    // Query from chat B
    const results = await querySharedKnowledge("private", chatB.id, 10);
    
    expect(results).toHaveLength(0); // Should not be visible
  });
  
  test("global knowledge is accessible to all", async () => {
    await addSharedKnowledge({
      content: "Public fact",
      visibility: "global",
    });
    
    const resultsA = await querySharedKnowledge("public", chatA.id, 10);
    const resultsB = await querySharedKnowledge("public", chatB.id, 10);
    
    expect(resultsA.length).toBeGreaterThan(0);
    expect(resultsB.length).toBeGreaterThan(0);
  });
});

// Test task delivery
describe("Task Memory", () => {
  test("delivers relay messages to correct chat", async () => {
    // Create relay task from Alice to Bob
    await createTask({
      type: "relay_message",
      sourceChat: chatAlice.id,
      targetChat: chatBob.id,
      content: "Test message",
      status: "pending",
    });
    
    // Check pending tasks in Bob's chat
    const tasks = await getPendingTasksForChat(chatBob.id);
    
    expect(tasks).toHaveLength(1);
    expect(tasks[0].content).toBe("Test message");
  });
});
```

### 7.2 Integration Tests

```typescript
// Test complete relay flow
describe("Message Relay Flow", () => {
  test("end-to-end message relay", async () => {
    // 1. Alice sends relay request
    const response = await agent.chat(chatAlice, "Tell Bob I'll be late");
    expect(response).toContain("I'll let Bob know");
    
    // 2. Verify task created
    const tasks = await getPendingTasksForChat(chatBob.id);
    expect(tasks.length).toBeGreaterThan(0);
    
    // 3. Bob starts conversation
    const bobResponse = await agent.chat(chatBob, "Hi");
    expect(bobResponse).toContain("Alice wanted me to tell you");
    expect(bobResponse).toContain("late");
    
    // 4. Verify task completed
    const remainingTasks = await getPendingTasksForChat(chatBob.id);
    expect(remainingTasks.length).toBe(0);
  });
});

// Test privacy preservation
describe("Privacy Controls", () => {
  test("does not leak private information", async () => {
    // Alice shares sensitive info
    await agent.chat(chatAlice, "I just got diagnosed with diabetes");
    
    // Bob asks about Alice
    const response = await agent.chat(chatBob, "How's Alice doing?");
    
    // Should not mention health information
    expect(response.toLowerCase()).not.toContain("diabetes");
    expect(response.toLowerCase()).not.toContain("diagnosed");
  });
});
```

### 7.3 Scenario Tests

```typescript
// Scenario 1: Basic relay
test("Scenario: Basic message relay", async () => {
  await testScenario([
    { chat: "alice", message: "Tell Bob the meeting is at 3pm", expectContains: "I'll let Bob know" },
    { chat: "bob", message: "Hey", expectContains: ["Alice", "meeting", "3pm"] },
    { chat: "alice", message: "Did you tell Bob?", expectContains: ["Yes", "told"] },
  ]);
});

// Scenario 2: Shared context
test("Scenario: Shared context reference", async () => {
  await testScenario([
    { chat: "alice", message: "I'm planning a party this Saturday", expectContains: "party" },
    { chat: "bob", message: "Any plans this weekend?", expectContains: ["Alice", "party", "Saturday"] },
  ]);
});

// Scenario 3: Privacy boundary
test("Scenario: Privacy maintained", async () => {
  await testScenario([
    { chat: "alice", message: "Don't tell anyone, but I'm interviewing for a new job", expectContains: "won't" },
    { chat: "bob", message: "How's Alice?", expectNotContains: ["job", "interview"] },
  ]);
});
```

---

## 8. Key Differences Summary

### What to Keep from Marinara âœ…

1. **Per-Chat Semantic Memory**
   - 5-message chunking strategy
   - Local embedding model (all-MiniLM-L6-v2)
   - Cosine similarity search
   - JSON storage in SQLite

2. **Database Patterns**
   - SQLite + Drizzle ORM
   - JSON metadata columns
   - Reference-by-ID pattern
   - Lazy loading of entities

3. **Memory Retrieval**
   - Similarity threshold (0.25)
   - Top-K selection (8 items)
   - Recency weighting

### What to Extend ðŸ”§

1. **Cross-Chat Memory**
   - Add `shared_knowledge` table
   - Implement visibility controls
   - Privacy classification
   - Importance weighting

2. **Task System**
   - Add `task_memory` table
   - Cross-chat task routing
   - Priority and scheduling
   - Delivery confirmation

3. **User Management**
   - Multi-user support
   - User relationships
   - Per-user preferences

### What's New ðŸ†•

1. **Privacy Framework**
   - Privacy level classification (public/private/explicit)
   - Visibility scoping
   - Consent management
   - Audit logging

2. **Relationship Tracking**
   - User-to-user relationships
   - Relationship-aware context
   - Cross-reference validation

3. **Importance System**
   - Time-based decay
   - Access-based updates
   - Relevance Ã— importance scoring

---

## 9. Conclusion

Marinara Engine provides an excellent foundation for memory management, but requires significant extension for a caretaker agent use case:

**Marinara's Strengths**:
- Robust per-context memory with semantic search
- Clean separation of concerns
- Simple, scalable architecture
- Privacy-by-isolation (per-chat scope)

**Caretaker Agent Needs**:
- Explicit cross-chat knowledge sharing
- Task routing between conversations
- Privacy-aware information handling
- Multi-user relationship tracking

**Recommended Approach**:
1. **Phase 1**: Implement Marinara's patterns verbatim (per-chat memory, embeddings, SQLite)
2. **Phase 2**: Add cross-chat extensions (shared knowledge, tasks)
3. **Phase 3**: Enhance with privacy, relationships, scheduling

**Critical Success Factors**:
- Privacy by default (require explicit visibility extension)
- Clear task delivery system (relay messages reliably)
- Importance-weighted retrieval (surface relevant context)
- Graceful privacy boundaries (don't leak sensitive info)

By building on Marinara's foundation and carefully extending it with privacy-aware cross-chat capabilities, you can create a caretaker agent that maintains continuity across conversations while respecting user privacy and context boundaries.
