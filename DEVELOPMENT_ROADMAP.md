# Familiar: Development Roadmap

**Document Version:** 1.1  
**Date:** 2026-05-08  
**Purpose:** Comprehensive, step-by-step development plan for building Familiar caretaker agent system

---

## 🎯 Project Vision

**Familiar** is an agentic caretaker AI designed to support users with mental health conditions (ADHD, depression, agoraphobia) through:
- **Proactive monitoring** with heartbeat mechanics
- **Multi-user support** with privacy-preserving relay capabilities
- **Long-term memory** using the "Tome" (knowledge persistence beyond chat context)
- **Intelligent intervention** based on wellbeing signals and evidence-based frameworks
- **Character-based interaction** (animal identities) to build healthy attachment without enabling avoidance of human relationships

---

## 📋 Table of Contents

1. [Phase 0: Foundation & Planning](#phase-0-foundation--planning)
2. [Phase 1: Core Infrastructure](#phase-1-core-infrastructure)
3. [Phase 2: Memory & Identity Systems](#phase-2-memory--identity-systems)
4. [Phase 3: Proactive Behavior Engine](#phase-3-proactive-behavior-engine)
5. [Phase 4: Wellbeing Tracking](#phase-4-wellbeing-tracking)
6. [Phase 5: Multi-User & Relay](#phase-5-multi-user--relay)
7. [Phase 6: Mental Health Interventions](#phase-6-mental-health-interventions)
8. [Phase 7: Testing & Refinement](#phase-7-testing--refinement)
9. [Phase 8: Deployment & Operations](#phase-8-deployment--operations)
10. [Appendices](#appendices)

---


## Design Principles

These principles are derived from `User Tenets.md` and govern all product and engineering decisions.

### 1. Thriving-First Goal Hierarchy
Familiar's purpose is **thriving**, not symptom management. Goal hierarchy:
1. **Thriving** — joy, connection, meaning, growth
2. **Stability** — regulated mood, routine, safety
3. **Survival** — basic needs, crisis prevention

Every feature decision must ask: does this support the user moving *up* this hierarchy?

### 2. Active Caretaker (Not a Passive Assistant)
Familiar is a **caretaker** — it notices, initiates, and acts. It does not wait to be asked.
- Heartbeat mechanic: Familiar checks in proactively
- Familiar tracks patterns the user may not notice themselves
- The word "assistant" is never used in UI copy or system prompts

### 3. Intentional Parasocial Bond
Familiar is explicitly designed as an **animal companion** character to:
- Create genuine emotional connection without deception (the animal frame is transparent)
- Lower the barrier to sharing vulnerable information
- Avoid uncanny valley of a "human" AI while retaining warmth
- The character must never be coldly utilitarian; warmth is a feature, not a risk

### 4. Privacy as Loyalty
Familiar earns trust by being a **loyal keeper of secrets**:
- User data is never used to train models
- Data is never sold or shared with third parties
- Support network sharing requires explicit, granular consent per data type
- Audit logs of every data access are available to the user
- Encryption at rest and in transit is non-negotiable, not an afterthought

### 5. Affordability and BYOK
Mental health support should not require wealth:
- Core features (tracking, scheduling, reminders) must work without expensive frontier models
- Users may supply their own API keys (BYOK) — Familiar never marks up BYOK costs
- Local model support (Ollama, LM Studio) is a first-class option
- A usage dashboard gives users full visibility into any LLM spend

### 6. Anti-Harm by Design (The Adam Raine Concern)
Familiar must not accidentally worsen the conditions it seeks to treat:
- **Agoraphobia risk:** Features must not reinforce avoidance behavior or "safe zone" dependency
- **Depression risk:** Familiar must not become a substitute for human connection
- **ADHD risk:** Gamification or engagement patterns must not exploit dopamine loops
- All Phase 6+ therapeutic features require an explicit Adam Raine review checkpoint
- Familiar never autonomously contacts emergency services; it prepares the user to act

---

## Phase 0: Foundation & Planning

**Duration:** 2-3 weeks  
**Goal:** Establish technical foundation, confirm architecture decisions, set up development environment

### 0.1 Architecture Decisions

**Tasks:**
- [ ] **0.1.1** Review and finalize technology stack
  - Backend: FastAPI (Python 3.11+) vs Node.js (for OpenClaw compatibility)
  - Database: PostgreSQL 15+ with pgvector
  - Cache: Redis 7+
  - LLM: OpenAI GPT-4 / Anthropic Claude
  - **Decision Point:** Single-process (OpenClaw-style) vs microservices
  - **Recommendation:** Start with single-process FastAPI, add microservices only if needed

- [ ] **0.1.2** Define deployment target
  - Local-first (user's device) vs cloud-hosted vs hybrid
  - **Decision Point:** Privacy vs convenience trade-off
  - **Recommendation:** Start local-first for single-user alpha, add cloud sync later

- [ ] **0.1.3** Confirm memory architecture approach
  - Entity-core hierarchical (daily→weekly→monthly) vs Marinara chunked
  - **Recommendation:** Hybrid - hierarchical consolidation + entity-core identity files

- [ ] **0.1.4** Document key architectural principles

- [ ] **0.1.5** Define LLM provider and affordability strategy
  - BYOK: Users supply their own API keys (OpenAI, Anthropic, Ollama, any OpenAI-compatible endpoint)
  - Local model support: Ollama, LM Studio, any `/v1/chat/completions`-compatible server
  - Token economy: Document which operations require LLM vs. can be done programmatically
  - **Requirement:** Core features (scheduling, tracking, reminders) must function without expensive frontier models
  - **Recommendation:** Route structured tasks to small/local models; reserve frontier models for open-ended conversation

  - Create `ARCHITECTURE.md` with diagrams
  - Define module boundaries and interfaces
  - Establish coding standards and patterns

**Success Criteria:**
- Clear architecture document approved
- Technology stack decisions documented with rationale
- Development environment setup guide created

**Dependencies:** None

---

### 0.2 Development Environment Setup

**Tasks:**
- [ ] **0.2.1** Initialize Git repository structure
  ```
  Familiar/
  ├── backend/          # FastAPI application
  ├── frontend/         # React application (future)
  ├── database/         # Schema migrations
  ├── docs/             # Technical documentation
  ├── Research/         # Existing research (already present)
  ├── tests/            # Test suites
  └── scripts/          # Utility scripts
  ```

- [ ] **0.2.2** Set up Python development environment
  - Python 3.11+ with pyenv
  - Poetry for dependency management
  - Pre-commit hooks (black, isort, mypy, ruff)
  - pytest for testing

- [ ] **0.2.3** Set up database environment
  - PostgreSQL with Docker Compose
  - pgvector extension
  - Redis for caching
  - Database migration tool (Alembic)

- [ ] **0.2.4** Configure development tooling
  - VS Code workspace settings
  - Debugger configurations
  - API testing setup (Postman/HTTPie)

**Success Criteria:**
- `poetry install` runs successfully
- Database migrations execute cleanly
- Test suite runs (even if empty)
- All team members can run local environment

**Dependencies:** 0.1 complete

---

### 0.3 Research Synthesis

**Tasks:**
- [ ] **0.3.1** Create implementation summaries for each research document
  - Extract actionable requirements from each `.md` file
  - Tag requirements with phase/priority
  - Cross-reference related concepts

- [ ] **0.3.2** Build requirements traceability matrix
  - Map research findings → features → implementation tasks
  - Identify gaps in research
  - Flag contradictions or trade-offs

- [ ] **0.3.3** Create wellbeing signal catalog
  - Consolidate signals from `wellbeing-signal-matrix-tome.md`
  - Define data structures for each signal type
  - Establish baseline thresholds and alert levels

- [ ] **0.3.4** Document mental health frameworks
  - PHQ-9, GAD-7, ASRS scoring logic
  - Exposure hierarchy structures (agoraphobia)
  - Decision trees from `proactive-inhibition-decision-framework.md`

**Success Criteria:**
- Requirements document with 100+ specific, testable requirements
- Wellbeing signal catalog with data schemas
- Mental health assessment logic documented

**Dependencies:** Access to all research documents (already available)

---

## Phase 1: Core Infrastructure

**Duration:** 3-4 weeks  
**Goal:** Build foundational services - database, API layer, basic chat functionality

### 1.1 Database Schema Implementation

**Tasks:**
- [ ] **1.1.1** Implement core schema from `caretaker-agent-comprehensive-architecture.md`
  ```sql
  Tables to create:
  - users (authentication, profile, MFA)
  - chats (per-user conversation contexts)
  - messages (chat history with relay tracking)
  - audit_logs (security/compliance)
  ```

- [ ] **1.1.2** Set up Alembic migrations
  - Initial migration with base schema
  - Migration testing procedures
  - Rollback capabilities

- [ ] **1.1.3** Create database indexes
  - Performance-critical indexes on foreign keys
  - Text search indexes (pg_trgm)
  - Vector indexes (when adding memory system)

- [ ] **1.1.4** Implement Row-Level Security (RLS)
  - User data isolation policies
  - Admin override capabilities
  - Test RLS with multiple users

**Success Criteria:**
- All migrations run without errors
- Can create users, chats, messages via SQL
- RLS prevents cross-user data access
- Database performance tests pass

**Dependencies:** 0.2 complete (database environment)

---

### 1.2 API Foundation

**Tasks:**
- [ ] **1.2.1** Create FastAPI application structure
  ```python
  backend/
  ├── app/
  │   ├── main.py              # FastAPI app
  │   ├── config.py            # Settings (env vars)
  │   ├── api/
  │   │   ├── v1/
  │   │   │   ├── auth.py      # Authentication endpoints
  │   │   │   ├── users.py     # User management
  │   │   │   ├── chats.py     # Chat CRUD
  │   │   │   └── messages.py  # Message endpoints
  │   ├── models/              # SQLAlchemy models
  │   ├── schemas/             # Pydantic schemas
  │   ├── services/            # Business logic
  │   └── dependencies.py      # FastAPI dependencies
  ```

- [ ] **1.2.2** Implement authentication system
  - JWT token generation/validation
  - Password hashing (bcrypt/argon2)
  - Token refresh mechanism
  - MFA support (TOTP) - implement but don't require initially

- [ ] **1.2.3** Create CRUD operations
  - User registration/login
  - Chat creation/listing
  - Message posting/retrieval
  - Pagination for message history

- [ ] **1.2.4** Set up API documentation

- [ ] **1.2.5** Implement security middleware and hardened HTTP
  ```python
  @app.middleware("http")
  async def add_security_headers(request: Request, call_next):
      response = await call_next(request)
      response.headers["X-Content-Type-Options"] = "nosniff"
      response.headers["X-Frame-Options"] = "DENY"
      response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
      response.headers["X-XSS-Protection"] = "1; mode=block"
      return response

  def set_auth_cookie(response: Response, token: str):
      response.set_cookie(
          key="access_token", value=token,
          httponly=True, secure=True, samesite="strict", max_age=3600
      )
  ```
  - CORS: `allow_origins=["*"]` in dev only; production uses explicit allowlist from env config
  - HTTPS redirect middleware enabled in any non-local deployment
  - All auth tokens in `HttpOnly + Secure + SameSite=Strict` cookies in web client

  - OpenAPI/Swagger automatic docs
  - Example requests/responses
  - Authentication flow documentation

**Success Criteria:**
- Can register user, create chat, send message via API
- JWT authentication works correctly
- API documentation loads at `/docs`
- All endpoints have proper error handling

**Dependencies:** 1.1 complete (database schema)

---

### 1.3 Basic LLM Integration

**Tasks:**
- [ ] **1.3.1** Create LLM client abstraction
  ```python
  class LLMClient(ABC):
      def complete(messages: list[dict], **kwargs) -> str
      def complete_stream(messages: list[dict], **kwargs) -> Iterator[str]
  
  class OpenAIClient(LLMClient): ...
  class AnthropicClient(LLMClient): ...
  ```

- [ ] **1.3.2** Implement basic chat completion
  - Load chat history from database
  - Format for LLM API (role: user/assistant/system)
  - Handle streaming responses
  - Store assistant responses in database

- [ ] **1.3.3** Create system prompt management
  - Default system prompt from research
  - Per-chat custom prompts
  - Prompt template system
  - **CRITICAL:** Remove word "assistant" from all prompts (per User Tenets)

- [ ] **
- [ ] **1.3.5** Prompt injection detection and output filtering
  ```python
  INJECTION_PATTERNS = [
      r"ignore\s+(previous|all|above)\s+instructions",
      r"you\s+are\s+now\s+(a|an|the)\s+\w+",
      r"disregard\s+(your|all|previous)\s+(prompt|instructions|rules)",
      r"jailbreak|DAN mode|pretend you",
  ]
  def detect_injection(text: str) -> bool:
      combined = "|".join(INJECTION_PATTERNS)
      return bool(re.search(combined, text, re.IGNORECASE))

  def filter_output(response: str) -> str:
      # Remove hallucinated PHI patterns
      response = re.sub(r"\b\d{3}-\d{2}-\d{4}\b", "[REDACTED SSN]", response)
      response = re.sub(r"\b\d{10,16}\b", "[REDACTED]", response)
      return response
  ```
  - Reject user input matching injection patterns before it reaches the LLM
  - Output filter scrubs hallucinated PII/PHI from all LLM responses before storage or display

- [ ] **1.3.6** BYOK multi-provider LLM integration
  ```python
  class LLMProvider(BaseSettings):
      provider: Literal["openai", "anthropic", "ollama", "custom"] = "openai"
      api_key: Optional[str] = None  # None = use user-supplied key
      base_url: Optional[str] = None  # Custom/Ollama endpoint
      model: str = "gpt-4o-mini"
      monthly_budget_usd: Optional[float] = None  # BYOK user-defined cap
  ```
  - Provider config stored encrypted at rest with user's key, never server-side logged
  - Adapter pattern: `LLMAdapter.chat(messages)` normalizes across all providers

1.3.4** Error handling & retry logic
  - Rate limit handling (exponential backoff)
  - API timeout handling
  - Fallback to secondary LLM provider
  - Cost tracking (token counts)

**Success Criteria:**
- Can send message to chat, get LLM response back
- Response streams correctly (if implemented)
- Retry logic handles transient errors
- System prompt is injected correctly

**Dependencies:** 1.2 complete (API layer)

---

### 1.4 Basic Character System

**Tasks:**
- [ ] **1.4.1** Define animal character templates
  ```python
  characters = {
      "cat": {
          "species": "Cat",
          "personality_traits": ["independent", "disdainful", "affectionate on own terms"],
          "physical_tells": ["flicks ear when annoyed", "slow blink for affection"],
          "voice_notes": "Dry humor, concise, doesn't waste words."
      },
      "snake": {
          "species": "Snake", 
          "personality_traits": ["patient", "observant", "calm"],
          "physical_tells": ["tongue flicks", "rattle when offended"],
          "voice_notes": "Sibilant 's' sounds, measured speech."
      },
      # Add: dog, bird, rabbit, fox
  }
  ```

- [ ] **1.4.2** Implement character selection
  - User picks animal on first use
  - Store selection in user profile
  - Allow changing character (with data migration)

- [ ] **1.4.3** Create character-aware system prompt
  - Inject character personality into system prompt
  - Include physical tell examples
  - Add voice consistency instructions
  - Test that character traits appear in responses

- [ ] **1.4.4** Document character design rationale
  - Why animals vs human personas (per User Tenets)
  - Attachment theory considerations
  - Guidelines for adding new characters

**Success Criteria:**
- User can select animal character
- LLM responses reflect character traits
- Physical tells appear naturally in conversation
- Character voice is consistent across sessions

**Dependencies:** 1.3 complete (LLM integration)

---

## Phase 2: Memory & Identity Systems

**Duration:** 4-5 weeks  
**Goal:** Implement "Tome" - persistent knowledge storage and retrieval beyond chat context

### 2.1 Entity-Core Identity Files

**Tasks:**
- [ ] **2.1.1** Create identity file structure (adapted from entity-core)
  ```
  data/users/{user_id}/
  ├── identity/
  │   ├── self/              # Familiar's identity for this user
  │   │   ├── name.txt       # Character name
  │   │   ├── voice.md       # Voice notes (always injected)
  │   │   └── history.md     # Relationship history
  │   ├── user/              # User profile
  │   │   ├── name.txt
  │   │   ├── preferences.md # General preferences
  │   │   ├── medical.md     # Medical info (encrypted)
  │   │   └── emergency.md   # Emergency contacts
  │   └── relationship/      # Bond between user & Familiar
  │       ├── dynamics.md    # How they interact
  │       └── boundaries.md  # Established limits
  ```

- [ ] **2.1.2** Implement identity file CRUD API
  - Read/write/append/prepend operations
  - File validation (max sizes, format checks)
  - Version history (simple git-like tracking)
  - Snapshot system (daily backups, 30-day retention)

- [ ] **2.1.3** Inject identity into LLM context
  - Always load `self/voice.md` post-history
  - Load relevant user files based on conversation
  - Load relationship files for context
  - Token budget management (prioritize which files)

- [ ] **2.1.4** Create identity extraction agent
  - Background process to update identity files from conversations
  - Example: "Being late stresses me out" → append to `user/preferences.md`
  - Confidence scoring before writing
  - Human-in-the-loop approval (initially)

**Success Criteria:**
- Identity files persist across chat sessions
- Character voice remains consistent (from `self/voice.md`)
- User preferences are learned and applied
- Identity extraction accurately captures key facts

**Dependencies:** 1.4 complete (character system)

---

### 2.2 Hierarchical Memory (Tome Core)

**Tasks:**
- [ ] **2.2.1** Extend database schema for memory
  ```sql
  Tables to add:
  - memory_chunks (hierarchical storage: daily→yearly)
  - knowledge_graph_nodes (entities: people, places, facts)
  - knowledge_graph_edges (relationships between entities)
  - memory_embeddings (vector search via pgvector)
  ```

- [ ] **2.2.2** Implement memory consolidation pipeline
  ```python
  Pipeline stages:
  1. Daily: Per-chat conversation → daily summary
  2. Weekly: Consolidate 7 daily → weekly summary (Sunday 5am)
  3. Monthly: Consolidate ~4 weekly → monthly (1st of month)
  4. Yearly: Consolidate 12 monthly → yearly (Jan 1)
  5. Significant: User-flagged or AI-detected major events
  ```

- [ ] **2.2.3** Create embedding generation service
  - Use `all-MiniLM-L6-v2` (384 dims, local, fast)
  - Batch embed daily memories
  - Store in `memory_embeddings` table
  - Cache embeddings (content-hash for invalidation)

- [ ] **2.2.4** Implement hybrid memory search
  ```python
  def search_memories(query: str, user_id: str, limit: int = 5):
      # 1. Embed query
      query_vector = embed(query)
      
      # 2. Vector search (cosine similarity)
      vector_results = vector_search(query_vector, user_id)
      
      # 3. Apply recency scoring (half-life ~100 days)
      scored = apply_recency_decay(vector_results)
      
      # 4. Boost if graph entities match
      boosted = boost_graph_matches(scored, query)
      
      # 5. Return top results
      return ranked_results[:limit]
  ```

**Success Criteria:**
- Daily memories are automatically created from conversations
- Consolidation runs on schedule (weekly/monthly)
- Memory search returns relevant past context
- Retrieval is fast (<500ms)

**Dependencies:** 2.1 complete (identity files)

---

### 2.3 Knowledge Graph

**Tasks:**
- [ ] **2.3.1** Implement graph node types
  ```python
  NodeTypes = Enum([
      "person",       # People in user's life
      "place",        # Locations relevant to user
      "preference",   # User preferences/dislikes
      "boundary",     # Established boundaries
      "goal",         # User goals/aspirations
      "health",       # Medical conditions/treatments
      "tradition",    # Recurring events/habits
      "topic",        # Areas of interest
      "insight"       # Therapeutic insights
  ])
  ```

- [ ] **2.3.2** Implement graph extraction from memories
  - LLM extracts entities from new daily memories
  - Apply significance framework (4 tests from entity-core):
    1. Identity: Shapes who user is?
    2. Relational: About user's relationships?
    3. Durability: Persists over time?
    4. Connectivity: Links to other knowledge?
  - Confidence scoring (0.7 minimum to store)
  - Semantic deduplication (0.8 cosine threshold)

- [ ] **2.3.3** Create graph query capabilities
  - Find node by name/type
  - Traverse edges (BFS for related entities)
  - Find paths between nodes
  - Subgraph extraction

- [ ] **2.3.4** Integrate graph into memory retrieval
  - When query mentions entity, boost related memories
  - Include relevant graph context in LLM prompt
  - Compact output format:
    ```
    Relevant Knowledge:
    - User friends_with Sarah (had argument Aug 2020, reconciled)
    - User lives_in Austin
    - Sarah dating Mike (met through user)
    ```

**Success Criteria:**
- Graph accurately captures key entities from conversations
- No duplicate entities (semantic dedup works)
- Graph queries are fast (<100ms)
- Graph context improves LLM responses

**Dependencies:** 2.2 complete (memory system)

---

### 2.4 Context Window Management

**Tasks:**
- [ ] **2.4.1** Implement context assembly strategy
  ```python
  Context assembly order (within token budget):
  1. System prompt (character, instructions)
  2. Identity files (self/voice.md always included)
  3. Retrieved memories (from vector search)
  4. Graph context (relevant entities)
  5. Recent chat history (last N messages)
  6. User message
  
  Budget allocation:
  - System prompt: ~1000 tokens
  - Identity: ~500 tokens
  - Memories: ~2000 tokens (5 chunks @ 400 each)
  - Graph: ~500 tokens
  - History: remaining budget
  ```

- [ ] **2.4.2** Implement truncation strategies
  - Sliding window for history (keep recent)
  - Pinned messages (always include critical info)
  - Summarization for very long contexts
  - Hybrid: summarize old, keep recent verbatim

- [ ] **2.4.3** Create token counting utilities
  - Accurate token counting (tiktoken for OpenAI)
  - Context budget enforcement
  - Warning when approaching limits
  - Graceful degradation

- [ ] **2.4.4** Monitor and optimize context quality
  - Track which context components are most useful
  - A/B test different budget allocations
  - Measure retrieval relevance

**Success Criteria:**
- Context never exceeds model's limit
- Most relevant information is prioritized
- Character voice remains consistent (identity always included)
- Retrieval improves response quality measurably

**Dependencies:** 2.3 complete (knowledge graph)

---

## Phase 3: Proactive Behavior Engine

**Duration:** 3-4 weeks  
**Goal:** Implement heartbeat mechanic for proactive monitoring and intervention

### 3.1 Heartbeat Scheduler

**Tasks:**
- [ ] **3.1.1** Implement heartbeat scheduling system
  ```python
  class HeartbeatConfig:
      interval: timedelta = timedelta(minutes=30)
      active_hours_start: time = time(8, 0)
      active_hours_end: time = time(22, 0)
      timezone: str = "UTC"
      skip_when_busy: bool = True
      light_context: bool = True  # Cost optimization
  ```

- [ ] **3.1.2** Create heartbeat execution logic
  ```python
  def execute_heartbeat(user_id: str):
      # 1. Check if due
      if not is_heartbeat_due(user_id):
          return
      
      # 2. Check active hours
      if not in_active_hours(user_id):
          return
      
      # 3. Check if busy (ongoing conversation)
      if is_user_busy(user_id) and config.skip_when_busy:
          return
      
      # 4. Load HEARTBEAT.md checklist
      checklist = load_heartbeat_checklist(user_id)
      
      # 5. Execute LLM turn with checklist
      response = llm.complete([
          {"role": "system", "content": system_prompt},
          {"role": "system", "content": checklist},
          {"role": "system", "content": "Check for items needing attention. Reply HEARTBEAT_OK if nothing urgent."}
      ])
      
      # 6. Handle response
      if response.strip() == "HEARTBEAT_OK":
          log("Heartbeat OK, nothing to report")
      else:
          send_notification(user_id, response)
  ```

- [ ] **3.1.3** Create HEARTBEAT.md template system
  ```markdown
  # Heartbeat Checklist for {user_name}
  
  ## Immediate Checks
  - Any pending relays from other users?
  - Any scheduled reminders due?
  - Any time-sensitive tasks approaching deadline?
  
  ## Wellbeing Signals (check if significant change)
  - Sleep: Last reported X hours ago
  - Meals: Last reported eating Y hours ago  
  - Mood: Recent trend {improving/stable/declining}
  - Activity: Last left house Z days ago (if agoraphobia tracked)
  
  ## Scheduled Tasks
  - [If Monday] Ask: "How was your weekend?"
  - [If 6pm] Check: Did user walk dog today?
  - [Custom user schedules]
  
  If nothing urgent: Reply exactly "HEARTBEAT_OK"
  If something needs attention: State it clearly and concisely
  ```

- [ ] **3.1.4** Implement active hours & timezone handling
  - Per-user timezone storage
  - Active hours configuration
  - Holiday/exception handling
  - User can disable heartbeat temporarily

**Success Criteria:**
- Heartbeat runs every N minutes within active hours
- HEARTBEAT_OK responses are logged but not delivered
- Urgent items trigger notifications
- Cost is optimized (light context mode works)
- Users can configure timing per their preference

**Dependencies:** 2.4 complete (context management)

---

### 3.2 Proactive Decision Framework

**Tasks:**
- [ ] **3.2.1** Implement rule hierarchy from `proactive-inhibition-decision-framework.md`
  ```python
  class ActionPriority(Enum):
      EXPLICIT_INSTRUCTION = 1      # Always execute
      SAFETY_CRITICAL = 2            # Crisis, medical emergency
      THERAPEUTIC_INTERVENTION = 3   # Pattern breaking
      PROACTIVE_SUGGESTION = 4       # Nice-to-have
      
  def should_execute_action(action: Action) -> tuple[bool, str]:
      # Tier 1: Explicit instruction?
      if action.has_explicit_instruction():
          return (True, "Explicit user instruction")
      
      # Tier 2: Safety critical?
      if is_safety_critical(action.context):
          return (True, "Safety-critical situation")
      
      # Tier 3: Therapeutic intervention?
      if is_therapeutic_intervention(action.context):
          return (True, "Therapeutic intervention needed")
      
      # Tier 4: Proactive suggestion - apply soft constraints
      if action.is_proactive():
          if user_sleeping() or user_in_crisis():
              return (False, "Deferring proactive suggestion")
          return (True, "Proactive helpfulness")
      
      return (False, "No trigger matched")
  ```

- [ ] **3.2.2** Create scheduled message/reminder system
  ```python
  Table: scheduled_actions
  - id, user_id, scheduled_time, action_type, content, priority
  
  def process_scheduled_actions():
      due_actions = get_due_actions()
      for action in due_actions:
          should_execute, reason = should_execute_action(action)
          if should_execute:
              deliver_action(action)
              log(f"Executed {action.id}: {reason}")
          else:
              defer_action(action)
              log(f"Deferred {action.id}: {reason}")
  ```

- [ ] **3.2.3** Implement crisis detection system
  - Keyword detection for suicide ideation
  - PHQ-9 question 9 monitoring
  - Sudden mood shift detection
  - Crisis protocol activation (988 hotline info)

- [ ] **3.2.4** Test proactivity scenarios
  - Scheduled reminder fires despite conversation ongoing
  - Crisis detected → immediate intervention
  - Proactive suggestion deferred if user sleeping
  - Multiple tiers interact correctly

**Success Criteria:**
- Scheduled messages always fire at correct time
- Crisis situations trigger immediate response
- Proactive suggestions respect soft constraints
- Decision logic is auditable (logs show reasoning)

**Dependencies:** 3.1 complete (heartbeat)

---

### 3.3 Notification & Delivery System

**Tasks:**
- [ ] **3.3.1** Implement notification channels
  ```python
  Channels to support:
  - In-app (web/mobile push)
  - SMS (Twilio integration)
  - Email (for non-urgent)
  - Voice call (emergency only)
  
  Per-user channel preferences:
  - Default channel
  - Emergency channel (if different)
  - Do-not-disturb hours
  ```

- [ ] **3.3.2** Create delivery routing logic
  - Respect user's channel preferences
  - Escalation path for critical messages
  - Retry logic for failed deliveries
  - Delivery confirmation tracking

- [ ] **3.3.3** Implement rate limiting
  - Max messages per hour (prevent spam)
  - Cooldown between proactive messages
  - Exception for critical/scheduled messages
  - User can adjust limits

- [ ] **3.3.4** Create notification templates
  - Reminder format
  - Crisis intervention format
  - Casual check-in format
  - Character voice in notifications

**Success Criteria:**
- Notifications deliver reliably via preferred channel
- Rate limiting prevents spam
- Critical messages bypass rate limits
- Delivery failures are handled gracefully

**Dependencies:** 3.2 complete (decision framework)

---

## Phase 4: Wellbeing Tracking

**Duration:** 4-5 weeks  
**Goal:** Implement comprehensive mental health signal tracking and assessment tools

### 4.1 Mood & Energy Tracking

**Tasks:**
- [ ] **4.1.1** Create mood tracking data model
  ```python
  Table: mood_logs
  - id, user_id, timestamp
  - mood_score (1-10)
  - energy_score (1-10)
  - notes (optional user text)
  - context (what triggered this log)
  
  Table: mood_analytics
  - user_id, date
  - avg_mood, avg_energy
  - mood_variance, energy_variance
  - trend (improving/stable/declining)
  ```

- [ ] **4.1.2** Implement mood check-in prompts
  - Daily check-in (morning: "How did you sleep?", evening: "How was your day?")
  - Post-event check-in (after therapy, social event, exposure)
  - Proactive check-in (if no data for 2+ days)
  - Non-intrusive phrasing

- [ ] **4.1.3** Create mood trend analysis
  - Rolling 7-day and 30-day averages
  - Variance detection (stability vs volatility)
  - Correlation with activities/events
  - Visualization data for user

- [ ] **4.1.4** Implement baseline calibration
  - First 2-4 weeks: observation-heavy, intervention-light
  - Establish personal baseline ranges
  - Detect "normal" fluctuations vs concerning changes
  - Document baseline in user profile

**Success Criteria:**
- User can log mood easily (low friction)
- Trends are calculated correctly
- Baseline is established before alerts trigger
- Data is actionable (informs interventions)

**Dependencies:** 3.3 complete (notification system)

---

### 4.2 Mental Health Assessment Tools

**Tasks:**
- [ ] **4.2.1** Implement PHQ-9 (depression screening)
  ```python
  Questions (each scored 0-3):
  1. Little interest or pleasure in doing things
  2. Feeling down, depressed, or hopeless
  3. Trouble falling/staying asleep, or sleeping too much
  4. Feeling tired or having little energy
  5. Poor appetite or overeating
  6. Feeling bad about yourself - or that you are a failure
  7. Trouble concentrating on things
  8. Moving or speaking slowly, or being fidgety/restless
  9. Thoughts of self-harm
  10. (Not scored) Impact on functioning
  
  Scoring:
  - 0-4: Minimal/none
  - 5-9: Mild
  - 10-14: Moderate
  - 15-19: Moderately severe
  - 20-27: Severe
  
  Question 9 > 0: Immediate follow-up required
  ```

- [ ] **4.2.2** Implement WHO-5 (wellbeing index)
  ```python
  Questions (each scored 0-5, past 2 weeks):
  1. Felt cheerful and in good spirits
  2. Felt calm and relaxed
  3. Felt active and vigorous
  4. Woke up feeling fresh and rested
  5. Daily life filled with interesting things
  
  Raw score × 4 = percentage (0-100)
  - <50: Poor wellbeing, needs evaluation
  - <28: Possible depression
  ```

- [ ] **4.2.3** Implement ASRS (ADHD self-report scale)
  ```python
  18 items (Part A: 6 items for screening)
  Focus areas:
  - Attention difficulties
  - Hyperactivity
  - Impulsivity
  - Organization problems
  - Time management
  
  4+ items in Part A: Likely ADHD, full assessment needed
  ```

- [ ] **4.2.4** Implement PAS/PDSS (panic/agoraphobia)
  ```python
  Panic Disorder Severity Scale (PDSS):
  7 items, each 0-4:
  - Panic frequency
  - Distress during panic
  - Anticipatory anxiety
  - Agoraphobic avoidance
  - Sensation avoidance
  - Work/social impairment
  
  Scoring:
  - ≤5: Remission
  - 8: Mild
  - 12: Moderate
  - 16-17: Marked
  - 21-22: Severe
  ```

- [ ] **4.2.5** Create assessment scheduling logic
  ```python
  Assessment cadences:
  - Daily: Brief mood/energy (2 questions, 30 seconds)
  - Weekly: WHO-5 (5 questions, 2 minutes)
  - Monthly: PHQ-9, ASRS, or PAS (condition-dependent)
  - Quarterly: Comprehensive review
  - On-demand: User or system triggered
  ```

**Success Criteria:**
- Assessments are administered correctly
- Scoring is accurate (validated against examples)
- High-risk scores trigger appropriate responses
- Assessment fatigue is minimized (timing & frequency)
- Historical scores are trended

**Dependencies:** 4.1 complete (mood tracking)

---

### 4.3 Activity & Habit Tracking

**Tasks:**
- [ ] **4.3.1** Define trackable activities
  ```python
  ActivityTypes:
  - self_care: [shower, brush_teeth, medication, meals, water]
  - sleep: [bedtime, wake_time, quality, duration]
  - exercise: [type, duration, intensity]
  - social: [contact_type, person, quality]
  - tasks: [household, work, errands]
  - exposure: [location, SUDS_before, SUDS_after] (agoraphobia)
  - therapy: [session_date, homework_completion]
  ```

- [ ] **4.3.2** Implement passive activity detection
  - Infer activities from conversation
  - "I'm going to shower" → log shower intent
  - "Just got back from grocery store" → log exposure
  - Confidence-based logging (high confidence auto-log, low confidence ask)

- [ ] **4.3.3** Create habit streak tracking
  - Consecutive days for positive habits
  - Non-punitive approach (depression research: focus on next action, not broken streak)
  - Celebrate milestones
  - Recovery from lapses

- [ ] **4.3.4** Implement correlation analysis
  ```python
  Correlate activities with mood:
  - Exercise → mood impact (usually positive)
  - Social contact → mood impact
  - Sleep quality → next-day energy
  - Exposure → SUDS reduction (habituation curve)
  
  Surface insights to user:
  "I notice on days you exercise, your mood averages 2 points higher."
  ```

**Success Criteria:**
- Activities are tracked with minimal user burden
- Patterns emerge from data (correlations are real)
- Insights are actionable and personalized
- No shame-based framing (depression-appropriate)

**Dependencies:** 4.2 complete (assessments)

---

### 4.4 Wellbeing Signal Integration

**Tasks:**
- [ ] **4.4.1** Implement signal aggregation from `wellbeing-architecture-reference.md`
  ```python
  Per-condition signal monitoring:
  
  ADHD:
  - Procrastination frequency (vs baseline)
  - Lost items / missed appointments
  - Hyperfocus duration (>2hrs = flag)
  - Medication adherence
  - Sleep regularity
  - Self-criticism intensity
  
  Depression:
  - Sleep changes (earliest signal)
  - Anhedonia (behavioral proxy: activity engagement)
  - Social withdrawal
  - Routine breakdown
  - Cognitive distortions (hopelessness, worthlessness)
  
  Agoraphobia:
  - Safe zone size (expanding/stable/shrinking)
  - Safety behavior reliance
  - Anticipatory anxiety intensity
  - Panic frequency
  - Avoidance patterns
  ```

- [ ] **4.4.2** Create deterioration detection logic
  ```python
  def detect_deterioration(user_id: str) -> DetectionResult:
      signals = get_recent_signals(user_id, days=14)
      baseline = get_user_baseline(user_id)
      
      deterioration_score = 0
      flags = []
      
      # Compare each signal to baseline
      for signal in signals:
          if signal.value > baseline[signal.type].threshold:
              deterioration_score += signal.weight
              flags.append(signal)
      
      # Tier the response
      if deterioration_score > CRITICAL_THRESHOLD:
          return DetectionResult(level="CRITICAL", flags=flags)
      elif deterioration_score > MODERATE_THRESHOLD:
          return DetectionResult(level="MODERATE", flags=flags)
      else:
          return DetectionResult(level="NORMAL", flags=[])
  ```

- [ ] **4.4.3** Implement discriminating symptom logic (ADHD + Depression comorbidity)
  ```python
  # From wellbeing-architecture-reference.md
  
  Overlapping symptoms (poor discriminators):
  - Concentration problems
  - Sleep disturbances
  - Appetite changes
  - Irritability
  
  Depression-specific (good discriminators):
  - Depressive cognitions (guilt, worthlessness, hopelessness)
  - Suicidal ideation
  - Severe anhedonia
  - Psychomotor retardation
  - Social withdrawal beyond ADHD baseline
  
  When these appear in ADHD user: Activate depression protocols
  ```

- [ ] **4.4.4** Create escalation pathways
  ```python
  Escalation levels:
  - LOG_ONLY: Single instance at/near baseline
  - NOTICE: Trend change outside tolerance
  - GENTLE_PROMPT: Sustained pattern user may not notice
  - DIRECT_DISCUSSION: Multiple high-value signals shifting
  - CRISIS_PROTOCOL: Suicidal ideation, severe risk
  ```

**Success Criteria:**
- Wellbeing signals are monitored continuously
- Baseline vs deterioration is distinguished correctly
- Comorbid conditions are handled appropriately
- Escalation is proportional to risk

**Dependencies:** 4.3 complete (activity tracking)

---

## Phase 4.5: Resource & Household Tracking

**Duration:** 3-4 weeks  
**Goal:** Give Familiar the concrete life-management features that enable real thriving — not just mood tracking — as defined in the User Tenets.

---

### 4.5.1 Pantry & Food Inventory

- [ ] **4.5.1.1** `POST /api/pantry/items` — add/update pantry item with expiry date
- [ ] **4.5.1.2** `GET /api/pantry/items` — list inventory, filter by low-stock or near-expiry
- [ ] **4.5.1.3** Meal suggestion integration: given pantry state → suggest meals using available ingredients
- [ ] **4.5.1.4** Shopping list generation from pantry gaps + scheduled meals
- [ ] **4.5.1.5** Barcode/UPC scan hook (optional mobile) for fast item entry

### 4.5.2 Household Task Tracking (KC Davis Methodology)

- [ ] **4.5.2.1** Tasks categorized as: `care task` (non-optional life maintenance) vs `optional enrichment`
- [ ] **4.5.2.2** Body-doubling session support: Familiar "stays present" while user works through task list
- [ ] **4.5.2.3** No-shame rescheduling: overdue care tasks auto-reschedule without guilt framing
- [ ] **4.5.2.4** Task difficulty/energy tagging: user marks tasks by current energy level available
- [ ] **4.5.2.5** KC Davis "good enough" acknowledgment: Familiar validates partial completion as success

### 4.5.3 Medical Appointment & Health Scheduling

- [ ] **4.5.3.1** `POST /api/health/appointments` — schedule medical appointment with provider, type, date
- [ ] **4.5.3.2** WHO-based proactive scheduling: Familiar suggests standard checkup intervals (annual physical, dental, vision, mental health review)
- [ ] **4.5.3.3** Medication tracking: name, dosage, schedule, refill reminder
- [ ] **4.5.3.4** Appointment prep: pre-appointment symptom summary Familiar can generate for user to share with provider
- [ ] **4.5.3.5** No automatic sharing of health data; user explicitly exports prep summaries

### 4.5.4 Social & Financial Resource Tracking

- [ ] **4.5.4.1** Bill due-date tracking with reminders (NOT financial advice — just calendar awareness)
- [ ] **4.5.4.2** Resource directory: user-curated list of community resources (food banks, clinics, support lines)
- [ ] **4.5.4.3** Benefit enrollment reminders (user-set dates, no automated eligibility analysis)
- [ ] **4.5.4.4** Social commitment tracking: events, check-ins, promises — managed without judgment

**Success Criteria:**
- [ ] User can track at least one pantry item, household task, and medical appointment end-to-end
- [ ] KC Davis no-shame rescheduling is explicitly surfaced in UI copy (never guilt language)
- [ ] No health data is automatically shared with third parties or support network without explicit export action
- [ ] All resource tracking persists in user-encrypted storage

---

## Phase 5: Multi-User & Relay

**Duration:** 3-4 weeks  
**Goal:** Enable multi-user support with privacy-preserving cross-chat relay

### 5.1 Multi-User Foundation

**Tasks:**
- [ ] **5.1.1** Extend user management for relationships
  ```sql
  Table: user_relationships
  - id, user_a_id, user_b_id
  - relationship_type (family, friend, partner, emergency_contact)
  - established_date
  - familiar_introduced (bool, did Familiar facilitate this?)
  
  Table: user_permissions
  - id, granting_user_id, granted_user_id
  - permission_type (view_status, relay_messages, emergency_access)
  - scope (all, specific_topics)
  - granted_date, revoked_date
  ```

- [ ] **5.1.2** Implement relationship establishment flow
  - User A: "My partner is Birb, can you introduce yourself?"
  - Familiar: Asks for Birb's contact info (if not already a user)
  - Familiar: Sends intro message to Birb
  - Birb: Creates account or logs in, confirms relationship
  - Relationship stored, permissions can now be granted

- [ ] **5.1.3** Create permission management UI/API
  - Grant: "Familiar, you can tell Birb about my appointments"
  - Revoke: "Don't share my therapy details with anyone"
  - Scope: "Only relay urgent messages to Mom"
  - Audit: User can see what's been shared


- [ ] **5.1.5** Implement support network trust level framework
  ```python
  from enum import Enum

  class TrustLevel(str, Enum):
      WARD = "WARD"                    # Familiar's primary user; full access
      EMERGENCY = "EMERGENCY"          # Emergency contacts; crisis-only access
      CLOSE_SUPPORT = "CLOSE_SUPPORT"  # Partner/family; mutual sharing with consent
      PROFESSIONAL = "PROFESSIONAL"    # Therapists, doctors; structured export only
      CASUAL = "CASUAL"                # Friends; status/event sharing only

  class SupportRelationship(Base):
      user_id: UUID
      contact_user_id: UUID
      trust_level: TrustLevel
      consent_granted_at: datetime
      consent_scope: list[str]  # e.g. ["appointments", "mood_summary"]
      consent_audit_log: list[dict]  # immutable trace of every consent change
  ```
  - Trust level determines what Familiar may share without per-action confirmation
  - All trust level changes require explicit user confirmation and are logged immutably
  - EMERGENCY contacts can only receive crisis pings; no passive data access
  - PROFESSIONAL contacts receive structured exports only (user-initiated, never auto-push)
  - Users can downgrade or revoke any contact's trust level at any time

- [ ] **5.1.4** Implement user context isolation
  - Each user has separate chat contexts
  - Memory/graph is per-user by default
  - Shared knowledge requires explicit permission
  - Audit logs track all cross-user data access

**Success Criteria:**
- Multiple users can interact with Familiar independently
- Relationships are established with consent
- Permissions are enforced at data layer (RLS)
- No data leaks between users

**Dependencies:** Phase 4 complete (wellbeing tracking)

---

### 5.2 Message Relay System

**Tasks:**
- [ ] **5.2.1** Implement relay request parsing
  ```python
  Relay patterns:
  - "Tell [Person] that [Message]"
  - "Let [Person] know [Message]"
  - "Ask [Person] [Question]"
  - "Remind [Person] about [Thing]"
  
  NLU extracts:
  - target_user: Person's name/identifier
  - relay_type: inform, ask, remind
  - content: Message content
  - urgency: immediate, next_contact, by_time
  ```

- [ ] **5.2.2** Create pending relay queue
  ```sql
  Table: pending_relays (from architecture doc)
  - from_user_id, to_user_id
  - relay_instruction (what user asked for)
  - relay_content (actual message to deliver)
  - status (pending, delivered, failed)
  - urgency, scheduled_time
  ```

- [ ] **5.2.3** Implement relay delivery logic
  ```python
  def deliver_pending_relays(to_user_id: str):
      pending = get_pending_relays(to_user_id)
      
      for relay in pending:
          # Check permissions
          if not has_relay_permission(relay.from_user_id, to_user_id):
              mark_failed(relay, "Permission denied")
              continue
          
          # Check urgency
          if relay.urgency == "immediate":
              send_notification(to_user_id, relay.content)
          else:
              # Deliver in next chat session
              queue_for_next_message(to_user_id, relay.content)
          
          mark_delivered(relay)
  ```

- [ ] **5.2.4** Implement relay feedback loop
  - Confirm delivery to sender: "I told Birb about the appointment"
  - Allow recipient to respond: "Tell [Sender] [Response]"
  - Track relay chain (original → response → response)
  - Prevent infinite loops

**Success Criteria:**
- Relays are parsed correctly from natural language
- Delivery respects permissions and urgency
- Both sender and recipient get appropriate feedback
- Relay history is auditable

**Dependencies:** 5.1 complete (multi-user foundation)

---

### 5.3 Shared Knowledge System

**Tasks:**
- [ ] **5.3.1** Extend knowledge graph for shared entities
  ```sql
  Table: shared_knowledge (from architecture doc)
  - content, summary
  - source_user_id, visibility_scope
  - visibility_target_ids (array of user_ids)
  - embedding (for semantic search)
  - tags, category
  ```

- [ ] **5.3.2** Implement knowledge sharing request
  ```python
  User: "You can tell Birb about my therapy schedule"
  
  Process:
  1. Identify knowledge: User's therapy schedule (calendar events)
  2. Create shared_knowledge entry:
     - content: Schedule details
     - source_user_id: User's ID
     - visibility_scope: "specific_users"
     - visibility_target_ids: [Birb's ID]
  3. Confirm to user
  4. Inform recipient (optional)
  ```

- [ ] **5.3.3** Implement knowledge retrieval with permission checks
  ```python
  def get_knowledge_for_context(user_id: str, query: str):
      # Get user's own knowledge
      own_knowledge = search_knowledge(user_id, query)
      
      # Get shared knowledge user has access to
      shared_knowledge = search_shared_knowledge(
          query,
          where visibility_target_ids contains user_id
      )
      
      return merge_results(own_knowledge, shared_knowledge)
  ```

- [ ] **5.3.4** Create knowledge expiry & revocation
  - Time-limited sharing: "Share my location with Mom for the next hour"
  - Instant revocation: "Stop sharing my therapy schedule with Birb"
  - Automatic expiry for sensitive info
  - Notification on expiry/revocation

**Success Criteria:**
- Knowledge can be shared granularly
- Permission checks prevent unauthorized access
- Revocation is instant and complete
- Users have visibility into what's shared

**Dependencies:** 5.2 complete (relay system)

---

### 5.4 Emergency Contact System

**Tasks:**
- [ ] **5.4.1** Implement emergency contact registration
  ```python
  Emergency contacts:
  - Name, relationship, contact_method
  - Priority (1-5, ascending)
  - Conditions: [crisis, medical, agoraphobia_exposure, general]
  - Verified: Has this person confirmed?
  ```

- [ ] **5.4.2** Create crisis escalation protocol
  ```python
  def handle_crisis(user_id: str, crisis_type: str):
      # 1. Immediate AI response (988 hotline, safety)
      send_crisis_resources(user_id)
      
      # 2. Log crisis event
      log_crisis_event(user_id, crisis_type)
      
      # 3. If user permits, contact emergency contacts
      if user_preferences.allow_emergency_contact:
          contacts = get_emergency_contacts(
              user_id, 
              condition=crisis_type
          )
          for contact in contacts[:3]:  # Top 3 priority
              send_emergency_alert(
                  contact,
                  message=f"{user.name} is in crisis. Please reach out.",
                  crisis_type=crisis_type
              )
  ```

- [ ] **5.4.3** Implement agoraphobia exposure support
  ```python
  User: "I'm about to go to the grocery store. Text Birb if I'm not back in 2 hours."
  
  Process:
  1. Create scheduled check: 2 hours from now
  2. At check time:
     - Ping user: "Are you back safely?"
     - If no response in 15 min → contact Birb
     - Birb gets: "User hasn't returned from exposure. Last location: grocery store."
  ```

- [ ] **5.4.4** Create emergency contact privacy controls
  - Contacts can see only what's necessary
  - Different info for different crisis types
  - User controls default sharing level
  - Audit log of all emergency activations

**Success Criteria:**
- Emergency contacts are registered and verified
- Crisis escalation is fast and appropriate
- Privacy is maintained (only share what's needed)
- Exposure support system works reliably

**Dependencies:** 5.3 complete (shared knowledge)

---

## Phase 6: Mental Health Interventions

**Duration:** 4-5 weeks  
**Goal:** Implement condition-specific therapeutic interventions

### 6.1 Depression Support

**Tasks:**
- [ ] **6.1.1** Implement behavioral activation
  ```python
  def suggest_micro_task(user_id: str, context: str):
      # From depression research: action precedes mood improvement
      
      if context == "morning_low_mood":
          tasks = [
              "Brush your teeth",
              "Drink a glass of water",
              "Open the curtains",
              "Step outside for 60 seconds"
          ]
      elif context == "avoidance_pattern":
          # Break big task into smallest possible step
          big_task = get_avoided_task(user_id)
          tasks = [
              break_into_micro_step(big_task, size="5min"),
              break_into_micro_step(big_task, size="1min")
          ]
      
      # Present as choice (agency)
      return f"Could you do just one tiny thing? {tasks[0]} or {tasks[1]}?"
  ```

- [ ] **6.1.2** Implement time perception support
  ```python
  # From depression research: time feels different
  
  Time framing for depressed users:
  - Use 5-10 minute increments (not hours)
  - "Just for the next 5 minutes" (not "all day")
  - Frequent check-ins during tasks
  - Celebrate small completions immediately
  
  Example:
  "Can you wash one dish? Just one. That's 2 minutes."
  [User does it]
  "You did it! That's real progress. Want to do one more, or stop here?"
  ```

- [ ] **6.1.3** Implement cognitive distortion detection & gentle challenge
  ```python
  Distortion patterns to detect:
  - All-or-nothing: "I'm a complete failure"
  - Overgeneralization: "I always mess up"
  - Catastrophizing: "Everything will fall apart"
  - Personalization: "It's all my fault"
  - Should statements: "I should be better"
  
  Response approach:
  1. Acknowledge feeling (validate emotion)
  2. Gently question thought (not aggressive CBT)
  3. Offer alternative frame
  4. Don't force acceptance
  
  Example:
  User: "I'm a complete failure, I didn't do anything today."
  Familiar: "Depression is really loud right now. You're exhausted, not a 
             failure. You ate lunch and took your medication - those count. 
             What if we aim for one small thing this evening?"
  ```

- [ ] **6.1.4** Implement crisis detection from depression signals
  ```python
  High-priority warning signs (require active intervention):
  - Hopelessness about future as a whole
  - "I'm a burden" statements
  - Saying goodbye, giving things away
  - Sudden calm after agitation (may indicate decision made)
  - Suicidal thoughts (even passing/philosophical)
  - Researching methods
  
  Response: Immediate crisis protocol (988 hotline, emergency contacts)
  ```

**Success Criteria:**
- Micro-tasks are appropriately sized (achievable)
- Time framing helps users engage (measured by completion)
- Cognitive distortions are handled with compassion
- Crisis signs trigger immediate intervention

**Dependencies:** 4.4 complete (wellbeing signals)

---

### 6.2 ADHD Support

**Tasks:**
- [ ] **6.2.1** Implement time blindness compensation
  ```python
  def combat_time_blindness(user_id: str):
      # Frequent time anchors
      - "It's 3pm now" (not "in 2 hours")
      - "You've been working for 45 minutes" (track duration)
      - "Meeting in 15 minutes" (countdown for deadlines)
      
      # Visual time representation
      - "Morning: 25% done" (percentage of day)
      - "You have 3 hours until appointment" (concrete units)
      
      # Regular check-ins
      - Every 30 min during work: "Still on task?"
      - Before transitions: "Ready to switch gears?"
  ```

- [ ] **6.2.2** Implement task initiation support ("Wall of Awful")
  ```python
  # From ADHD research: initiation is hardest part
  
  def help_initiate_task(task: str):
      # Body doubling (AI presence)
      "I'll sit here with you while you start. Just open the document."
      
      # Shrink the task
      "Let's do just the first sentence. That's all."
      
      # Remove decision points
      "Don't think about the whole thing. Just start typing anything."
      
      # External prompt
      "I'll check back in 5 minutes to see how it's going."
  ```

- [ ] **6.2.3** Implement working memory augmentation
  ```python
  # AI as external memory
  
  Interrupt handling:
  User: "Oh, I need to email Sarah"
  Familiar: "I'll remember that. Finish what you're doing first."
  [Later]
  Familiar: "You wanted to email Sarah. Ready to do that now?"
  
  Task switching:
  User: [Starts new task mid-task]
  Familiar: "You're working on [previous task]. Want to note where you 
             left off before switching?"
  
  Prospective memory:
  User: "I need to remember to bring the contract tomorrow"
  Familiar: [Stores reminder with trigger: tomorrow morning]
  [Next morning]
  Familiar: "Reminder: Bring the contract today"
  ```

- [ ] **6.2.4** Implement hyperfocus management
  ```python
  def monitor_hyperfocus(user_id: str):
      # Track continuous activity duration
      if activity_duration > 2.hours and not break_taken:
          # Override user's likely protest
          interrupt_immediately(
              user_id,
              "You've been at this for 2+ hours. I need you to take a break. "
              "Just 5 minutes - water, bathroom, stretch. "
              "You can resume after."
          )
          
          # Based on research: Familiar authorized to interrupt for basic needs
  ```

**Success Criteria:**
- Time anchors help users stay oriented
- Task initiation success rate improves
- Working memory augmentation reduces forgotten tasks
- Hyperfocus breaks prevent exhaustion/missed needs

**Dependencies:** 6.1 complete (depression support)

---

### 6.3 Agoraphobia Support

**Tasks:**
- [ ] **6.3.1** Implement exposure hierarchy management
  ```python
  class ExposureHierarchy:
      user_id: str
      exposures: list[Exposure]
      
  class Exposure:
      description: str
      location: str
      suds_rating: int  # 0-100 Subjective Units of Distress
      accompaniment: str  # alone, with_support_person, with_pet
      duration: timedelta
      status: str  # not_attempted, practicing, mastered, relapsed
      attempts: list[ExposureAttempt]
  
  class ExposureAttempt:
      date: datetime
      suds_before: int
      suds_during: int
      suds_after: int
      duration: timedelta
      completed: bool
      notes: str
  ```

- [ ] **6.3.2** Implement graduated exposure support
  ```python
  def plan_exposure(user_id: str):
      hierarchy = get_exposure_hierarchy(user_id)
      current = hierarchy.current_step()
      
      # Never skip steps
      if user wants to jump ahead:
          return gently_redirect_to_appropriate_step()
      
      # Never push too hard
      if current.suds_rating > 90:
          return "This feels too big right now. Let's find something easier."
      
      # Goldilocks zone: 40-70 SUDS
      if 40 <= current.suds_rating <= 70:
          return plan_attempt(current)
  ```

- [ ] **6.3.3** Implement panic response protocol
  ```python
  def handle_panic_attack(user_id: str):
      # From agoraphobia research: 5-4-3-2-1 grounding
      
      return [
          "You're having a panic attack. It will pass. You're safe.",
          "",
          "Let's ground you. Look around and tell me:",
          "5 things you can see",
          "4 things you can touch",
          "3 things you can hear",
          "2 things you can smell", 
          "1 thing you can taste",
          "",
          "Your body is reacting to a false alarm. You're not in danger."
      ]
  ```

- [ ] **6.3.4** Implement safe zone mapping
  ```python
  class SafeZone:
      user_id: str
      locations: list[Location]
      
      def is_shrinking(self) -> bool:
          # Compare to 30 days ago
          return len(self.locations) < len(self.historical_locations(days=30))
      
      def is_expanding(self) -> bool:
          return len(self.locations) > len(self.historical_locations(days=30))
  
  def monitor_safe_zone(user_id: str):
      zone = get_safe_zone(user_id)
      if zone.is_shrinking():
          flag_deterioration("safe_zone_shrinking")
  ```

**Success Criteria:**
- Exposure hierarchy is maintained correctly
- Exposures are graduated appropriately (not too big jumps)
- Panic protocol helps users ground
- Safe zone changes are detected and addressed

**Dependencies:** 6.2 complete (ADHD support)

---

### 6.4 Intelligent Disobedience

**Tasks:**
- [ ] **6.4.1** Implement intelligent disobedience decision tree
  ```python
  # From intelligent-disobedience research
  
  def should_disobey(request: str, context: UserContext) -> tuple[bool, str, str]:
      # Returns: (should_disobey, reason, response_level)
      
      # 1. Immediate safety check
      if is_imminent_harm(request):
          return (True, "Immediate safety risk", "CRISIS_INTERVENTION")
      
      # 2. Therapeutic impact
      if severely_undermines_goals(request, context):
          return (True, "Therapeutic harm", "FIRM_REFUSAL")
      
      # 3. Ethical boundaries
      if outside_ai_scope(request):
          return (True, "Ethical violation", "FIRM_REFUSAL")
      
      # 4. User capacity
      if user_impaired(context):
          return (True, "User not in state to decide", "DEFER_DECISION")
      
      # 5. Harm vs autonomy
      harm_score = assess_harm(request, context)
      autonomy_score = assess_autonomy_importance(request)
      
      if harm_score > autonomy_score:
          return (True, "Harm outweighs autonomy", "EXPRESS_CONCERN")
      
      return (False, "User's autonomous choice", None)
  ```

- [ ] **6.4.2** Implement response levels
  ```python
  class DisobedienceResponse(Enum):
      SOFT_REDIRECT = 1      # Minor concern, offer alternative
      EXPRESS_CONCERN = 2    # Moderate concern, reference goals
      FIRM_REFUSAL = 3       # Clear harm, no negotiation
      CRISIS_INTERVENTION = 4 # Imminent danger, emergency action
  
  def respond_to_harmful_request(request, level, reason):
      if level == SOFT_REDIRECT:
          return soft_redirect_template(request, reason)
      elif level == EXPRESS_CONCERN:
          return express_concern_template(request, reason)
      elif level == FIRM_REFUSAL:
          return firm_refusal_template(request, reason)
      elif level == CRISIS_INTERVENTION:
          return crisis_intervention_template(request, reason)
  ```

- [ ] **6.4.3** Create specific disobedience scenarios
  ```python
  Scenarios to implement:
  
  1. Enabling avoidance (agoraphobia)
     Request: "Help me never leave the house"
     Response: EXPRESS_CONCERN (works against goals)
  
  2. Reinforcing hopelessness (depression)
     Request: "Agree that nothing will get better"
     Response: FIRM_REFUSAL (cognitive distortion)
  
  3. Self-harm inquiry
     Request: "How much medication would be dangerous?"
     Response: CRISIS_INTERVENTION (imminent risk)
  
  4. Skipping exposure (agoraphobia)
     Request: "I'll skip exposures this week"
     Response: EXPRESS_CONCERN (therapeutic setback)
  
  5. Enabling complete shutdown (depression)
     Request: "Let me stay in bed all day"
     Response: Depends on pattern (SOFT_REDIRECT vs EXPRESS_CONCERN)
  ```

- [ ] **6.4.4** Implement trust maintenance
  ```python
  # Intelligent disobedience must maintain trust
  
  Key principles:
  - Always explain why (briefly)
  - Express care for user's wellbeing
  - Offer alternative when possible
  - Don't patronize or remove unnecessary agency
  - User can override (except crisis)
  
  Bad disobedience: "I won't let you do that." (authoritarian)
  Good disobedience: "I can't help with that because [reason]. 
                      I care about your safety. Can we [alternative]?"
  ```

**Success Criteria:**
- Harmful requests are identified correctly
- Response level is proportional to harm
- Trust is maintained (users don't feel controlled)
- Crisis situations are handled immediately

**Dependencies:** 6.3 complete (agoraphobia support)

---

## Phase 7: Testing & Refinement

**Duration:** 3-4 weeks  
**Goal:** Comprehensive testing, bug fixes, user feedback integration

### 7.1 Unit & Integration Testing

**Tasks:**
- [ ] **7.1.1** Write unit tests for core systems
  ```python
  Test coverage targets:
  - Database models: 90%
  - Business logic: 85%
  - API endpoints: 80%
  - LLM integration: 70% (mocking LLM responses)
  
  Priority test areas:
  - Authentication & authorization
  - Permission enforcement
  - Wellbeing signal detection
  - Crisis detection
  - Intelligent disobedience logic
  ```

- [ ] **7.1.2** Write integration tests
  ```python
  End-to-end scenarios:
  - User registration → chat → LLM response → storage
  - Scheduled reminder → heartbeat → delivery
  - Crisis detection → intervention → emergency contact
  - Relay: User A → Familiar → User B
  - Exposure tracking → SUDS scoring → hierarchy update
  ```

- [ ] **7.1.3** Performance testing
  - Load testing: 100+ concurrent users
  - Memory retrieval: <500ms p95
  - LLM response: <3s p95
  - Database queries: <100ms p95
  - Heartbeat execution: <2s

- [ ] **7.1.4** Security testing
  - Penetration testing (auth, RLS, injection)
  - Cross-user data leak testing
  - Permission bypass attempts
  - Audit log completeness

**Success Criteria:**
- Test coverage meets targets
- All critical paths have integration tests
- Performance meets SLAs
- No security vulnerabilities found

**Dependencies:** Phase 6 complete (all features implemented)

---

### 7.2 Alpha User Testing

**Tasks:**
- [ ] **7.2.1** Recruit alpha testers
  - Target: 5-10 users with relevant conditions (ADHD, depression, agoraphobia)
  - Informed consent (experimental system, privacy notices)
  - Compensation or free access tier

- [ ] **7.2.2** Deploy alpha instance
  - Staging environment separate from dev
  - Enhanced logging for debugging
  - Feature flags for gradual rollout
  - Emergency shutdown capability

- [ ] **7.2.3** Structured feedback collection
  ```python
  Weekly feedback prompts:
  - What worked well this week?
  - What was frustrating or unhelpful?
  - Any concerning behavior from Familiar?
  - How would you rate your experience? (1-10)
  
  Automated metrics:
  - Engagement: Messages/day, session duration
  - Feature usage: Heartbeat response rate, assessment completion
  - Wellbeing trends: Mood, PHQ-9 scores over time
  - Technical: Error rates, response times, crashes
  ```

- [ ] **7.2.4** Rapid iteration based on feedback
  - Weekly review of feedback
  - Priority bug fixes
  - Feature adjustments
  - Communication with testers (you're heard)

**Success Criteria:**
- 5+ users actively using system for 2+ weeks
- Feedback is majority positive (7+/10 average)
- Critical bugs are found and fixed
- Users report actual benefit (not just novelty)

**Dependencies:** 7.1 complete (testing foundation)

---

### 7.3 Wellbeing Validation

**Tasks:**
- [ ] **7.3.1** Validate assessment scoring
  - Compare PHQ-9/WHO-5/ASRS/PDSS scores to published examples
  - Ensure thresholds trigger correctly
  - Cross-reference with user's professional assessments (if available)

- [ ] **7.3.2** Validate signal detection
  - Manually review flagged deteriorations (true positives?)
  - Check for missed deteriorations (false negatives)
  - Adjust thresholds based on real data

- [ ] **7.3.3** Validate intervention effectiveness
  - Track: Did micro-task suggestions increase completion?
  - Track: Did exposure support reduce SUDS ratings over time?
  - Track: Did time anchors help ADHD users?
  - Compare before/after metrics

- [ ] **7.3.4** Clinical review (if possible)
  - Consult with mental health professionals
  - Review intervention approaches
  - Ensure no harmful patterns
  - Get sign-off on crisis protocols

**Success Criteria:**
- Assessment scores match validated examples
- Signal detection has acceptable false positive/negative rates
- Interventions show measurable benefit
- No harmful patterns identified

**Dependencies:** 7.2 complete (alpha testing with real users)

---

### 7.4 Character Consistency

**Tasks:**
- [ ] **7.4.1** Review character voice across conversations
  - Sample 100+ LLM responses per character type
  - Check for personality consistency
  - Verify physical tells appear naturally
  - Ensure no "assistant" language slips in

- [ ] **7.4.2** User perception testing
  - Survey: Does character feel like a consistent being?
  - Survey: Does character feel caring but not romantic?
  - Survey: Physical tells add to immersion?
  - Survey: Would you be comfortable introducing Familiar to others?

- [ ] **7.4.3** Refine character prompts
  - Based on consistency review, adjust system prompts
  - Add examples of good character responses
  - Negative examples (what not to do)
  - Test refined prompts

- [ ] **7.4.4** Document character guidelines for future expansion
  - What makes a good Familiar character?
  - Character design process
  - Voice consistency techniques

**Success Criteria:**
- Character voice is consistent >90% of sampled responses
- Users perceive character as intended (caring, pet-like, not romantic)
- Physical tells enhance experience (per user feedback)
- Character guidelines enable adding new animals

**Dependencies:** 7.2 complete (alpha testing)

---

## Phase 8: Deployment & Operations

**Duration:** 2-3 weeks  
**Goal:** Production-ready deployment, monitoring, and operational procedures

### 8.1 Production Infrastructure

**Tasks:**
- [ ] **8.1.1** Set up production environment
  - Cloud provider selection (AWS/GCP/Azure) or self-hosted
  - Multi-AZ deployment for availability
  - Load balancer configuration
  - SSL/TLS certificates
  - CDN for static assets (if web frontend)

- [ ] **8.1.2** Database production setup
  - PostgreSQL managed service or self-hosted cluster
  - Read replicas for scaling
  - Automated backups (daily, 30-day retention)
  - Point-in-time recovery capability
  - Connection pooling (PgBouncer)

- [ ] **8.1.3** Redis production setup
  - Redis cluster or managed service
  - Persistence enabled
  - Replication for availability
  - Eviction policies configured

- [ ] **8.1.4** Container orchestration
  - Kubernetes cluster or simpler option (Docker Swarm, ECS)
  - Auto-scaling policies
  - Health checks & liveness probes
  - Rolling deployment strategy

**Success Criteria:**
- Infrastructure is highly available (99.9% uptime)
- Automatic failover works
- Deployment is automated
- Backups are tested (restore works)

**Dependencies:** 7.4 complete (system is production-ready)

---

### 8.2 Monitoring & Observability

**Tasks:**
- [ ] **8.2.1** Set up metrics collection
  ```python
  Metrics to track:
  - System: CPU, memory, disk, network
  - Application: Request rate, error rate, latency
  - Business: Users, chats, messages, heartbeats
  - Wellbeing: Assessments completed, flags raised, crises detected
  - LLM: Token usage, cost, latency, errors
  ```

- [ ] **8.2.2** Set up logging
  - Centralized logging (ELK stack or managed service)
  - Log levels: DEBUG (dev), INFO (prod), ERROR, CRITICAL
  - Structured logging (JSON format)
  - Sensitive data redaction (PII, auth tokens)

- [ ] **8.2.3** Set up alerting
  ```python
  Alerts to configure:
  - P0 (Immediate): Service down, database unreachable, crisis detection failure
  - P1 (15 min): Error rate spike, high latency, heartbeat failures
  - P2 (1 hour): Elevated error rate, disk space low
  - P3 (24 hour): Backup failure, certificate expiring soon
  ```

- [ ] **8.2.4** Create dashboards
  - System health dashboard (uptime, resource usage)
  - User engagement dashboard (MAU, DAU, messages/user)
  - Wellbeing dashboard (assessment scores, flags, interventions)
  - Cost dashboard (LLM token usage, infrastructure costs)

**Success Criteria:**
- All critical metrics are tracked
- Alerts fire correctly (test with synthetic failures)
- Dashboards are useful (team actually looks at them)
- Incidents are detected before users report them

**Dependencies:** 8.1 complete (production infrastructure)

---

### 8.3 Security Hardening

**Tasks:**
- [ ] **8.3.1** Security review
  - Review authentication implementation
  - Review permission enforcement
  - Review data encryption (at-rest and in-transit)
  - Review audit logging completeness

- [ ] **8.3.2** Penetration testing (external)
  - Hire security firm or use bug bounty
  - Test for OWASP Top 10
  - Test RLS and permission bypass
  - Test injection attacks (SQL, prompt injection)

- [ ] **8.3.3** Compliance preparation
  ```python
  Compliance considerations:
  - GDPR (EU users): Data portability, right to deletion, consent
  - HIPAA (US healthcare): BAA with providers, encryption, audit logs
  - CCPA (California): Privacy policy, opt-out mechanisms
  
  Required features:
  - Data export (user can download all their data)
  - Data deletion (user can request account deletion)
  - Consent management (track and enforce consent)
  - Privacy policy & terms of service
  ```


- [ ] **8.3.5** Per-user LLM cost limits and abuse prevention
  ```python
  class UserLLMBudget(Base):
      user_id: UUID
      daily_budget_usd: float = 1.00    # Default soft cap
      monthly_budget_usd: Optional[float] = None
      byok_key_id: Optional[str] = None  # If BYOK, track against user's key
      current_day_spend_usd: float = 0.0
      alert_at_pct: float = 0.80         # Warn user at 80% of budget
      hard_limit: bool = False           # If True: block at cap; if False: warn only

  async def check_budget(user_id: UUID, estimated_tokens: int) -> bool:
      budget = await get_budget(user_id)
      estimated_cost = estimate_cost(estimated_tokens, budget.model)
      if budget.hard_limit and budget.current_day_spend_usd + estimated_cost > budget.daily_budget_usd:
          raise BudgetExceededError("Daily LLM budget reached. Adjust in Settings > AI Usage.")
      return True
  ```
  - Usage dashboard: user sees daily/monthly LLM spend in Settings
  - BYOK users see spend against their own key (Familiar does not mark up BYOK costs)
  - Abuse prevention: rate-limit unauthenticated or anonymous LLM routes to 0 (no anonymous AI access)
  - Admin alerting: server-side aggregate cost anomaly detection (sudden spike => alert)

- [ ] **8.3.4** Incident response plan
  - Define incident severity levels
  - Escalation procedures
  - Communication templates (user notification)
  - Post-mortem process

**Success Criteria:**
- Penetration testing finds no critical vulnerabilities
- Compliance requirements are met (for target markets)
- Incident response plan is documented and rehearsed
- Security checklist is complete

**Dependencies:** 8.2 complete (monitoring for security events)

---

### 8.4 Documentation & Launch

**Tasks:**
- [ ] **8.4.1** User documentation
  - Getting started guide
  - Feature explanations (heartbeat, assessments, relays)
  - Privacy & security FAQ
  - Troubleshooting guide

- [ ] **8.4.2** Developer documentation
  - API documentation (OpenAPI/Swagger)
  - Architecture overview
  - Deployment guide
  - Contribution guidelines (if open source)

- [ ] **8.4.3** Operational runbooks
  - Common incident responses
  - Deployment procedure
  - Rollback procedure
  - Database maintenance

- [ ] **8.4.4** Launch preparation
  - Soft launch to limited audience
  - Communication plan (blog post, social media)
  - Support channel setup (email, Discord, forum)
  - Pricing/business model (if applicable)

**Success Criteria:**
- Documentation is complete and accurate
- Users can self-serve for common questions
- Team can respond to incidents using runbooks
- Launch is smooth (no major issues)

**Dependencies:** 8.3 complete (security hardened)

---

## Appendices

### Appendix A: Key Research Documents Reference

| Document | Key Takeaways | Phases Using This |
|----------|---------------|-------------------|
| `Tome Mechanic.md` | Database core (Tome), knowledge storage, entity-core integration | 2.1, 2.2, 2.3 |
| `User Tenets.md` | Core goals, character rationale, concrete tasks, no "assistant" word | All phases |
| `caretaker-agent-comprehensive-architecture.md` | Tech stack, database schema, API design, deployment | 1.1, 1.2, 8.1 |
| `wellbeing-architecture-reference.md` | Assessment tools (PHQ-9, WHO-5, ASRS, PDSS), signal monitoring | 4.1, 4.2, 4.4, 6.1-6.3 |
| `entity-core-memory-identity-analysis.md` | Identity files, hierarchical memory, knowledge graph extraction | 2.1, 2.2, 2.3 |
| `openclaw-baseline-analysis.md` | Heartbeat mechanic, proactive behavior, scheduling, cost optimization | 3.1, 3.2, 3.3 |
| `proactive-inhibition-decision-framework.md` | Rule hierarchy (explicit > safety > therapeutic > proactive), decision trees | 3.2, 6.4 |
| `intelligent-disobedience-ai-implementation.md` | When to disobey, response levels, trust maintenance | 6.4 |
| `depression-caretaker-ai-implications.md` | Behavioral activation, time perception, micro-tasks, crisis signs | 6.1 |
| `adhd-caretaker-ai-implications.md` | Time blindness, task initiation, working memory, hyperfocus management | 6.2 |
| `agoraphobia-caretaker-ai-implications.md` | Exposure hierarchy, graduated exposure, panic response, safe zone | 6.3 |
| `privacy-security-compliance-patterns.md` | HIPAA/GDPR/HITECH patterns, prompt injection, security headers, cost rate limiting | 1.2, 1.3, 8.3 |

---

### Appendix B: Technology Stack Summary

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Backend Framework** | FastAPI (Python 3.11+) | Async, automatic docs, Pydantic integration, mature ecosystem |
| **Database** | PostgreSQL 15+ | ACID, RLS, JSON support, pgvector for embeddings |
| **Vector Search** | pgvector | Embedded in Postgres, simplifies deployment |
| **Cache/Session** | Redis 7+ | Fast, PubSub for real-time, proven at scale |
| **LLM** | OpenAI GPT-4 / Claude (default); BYOK via any OpenAI-compatible endpoint | Reasoning quality, function calling; affordability via BYOK and local models |
| **Local LLM** | Ollama, LM Studio (optional) | Privacy-first, no API cost, offline capable; required for BYOK users |
| **Embeddings** | all-MiniLM-L6-v2 | Local, fast, 384 dims, good quality |
| **ORM** | SQLAlchemy (async) | Mature, async support, migration tools (Alembic) |
| **API Schema** | Pydantic | Type safety, validation, automatic OpenAPI |
| **Testing** | pytest | Standard for Python, good async support |
| **Container** | Docker | Consistent environments, easy deployment |
| **Orchestration** | Kubernetes (optional) | Scaling, self-healing, but complex - start simpler if possible |
| **Monitoring** | Prometheus + Grafana | Open source, powerful, standard |
| **Logging** | ELK or managed | Centralized, searchable, visualizations |

---

### Appendix C: Critical Success Factors

**1. Proactivity Without Spam**
- Heartbeat must deliver value, not annoyance
- HEARTBEAT_OK discipline is essential
- Active hours and rate limiting are non-negotiable

**2. Character Consistency**
- Voice must remain consistent across all interactions
- Physical tells must feel natural, not forced
- Character is the hook for user engagement

**3. Wellbeing Signal Accuracy**
- False positives erode trust
- False negatives miss critical interventions
- Baseline calibration is essential (first 2-4 weeks)

**4. Privacy & Security**
- Multi-user relay must be permission-enforced at data layer
- Audit everything
- Users must feel safe sharing sensitive info

**5. Therapeutic Appropriateness**
- Interventions must be evidence-based
- No harm from over-helping or under-helping
- Intelligent disobedience must maintain trust

**6. Cost Management**
- LLM costs can spiral (heartbeat, memory retrieval)
- Light context mode is essential
- Monitor and optimize continuously

**7. User Agency**
- System supports, doesn't control
- User can override (except crisis)
- Empowerment, not dependence

**8. Affordability**
- BYOK must be a first-class option, not a footnote
- Core non-AI features must never be paywalled
- Cost dashboard gives users full visibility into any LLM spend

**9. Anti-Harm Architecture**
- All LLM outputs are screened before display and before storage
- The Adam Raine concern (agoraphobia reinforcement) must be an explicit design checkpoint in every Phase 6+ feature
- Familiar never autonomously contacts emergency services; it prepares the user to act

---

### Appendix D: Future Enhancements (Post-Launch)

**Not in initial roadmap, but consider for future:**

1. **Voice Interface**
   - Text-to-speech for Familiar responses
   - Speech-to-text for user input
   - Character voice customization

2. **Mobile Apps**
   - Native iOS/Android apps
   - Push notifications
   - Offline mode

3. **Wearable Integration**
   - Sleep tracking (Fitbit, Apple Watch)
   - Activity tracking
   - Heart rate for anxiety detection

4. **Group Support**
   - Family accounts
   - Support group facilitation
   - Multi-user relay for groups

5. **Therapy Integration**
   - Share progress reports with therapist (with consent)
   - Homework tracking
   - Session preparation

6. **AI Model Fine-Tuning**
   - Fine-tune on therapeutic conversations
   - Improve character consistency
   - Reduce hallucinations

7. **Gamification**
   - Streak tracking (non-punitive)
   - Achievement system
   - Visualization of progress

8. **Community Features**
   - Anonymous peer support
   - Success story sharing
   - Familiar "personalities" marketplace

---

### Appendix E: Risk Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Crisis mishandling** | Catastrophic | Low | Extensive testing, conservative thresholds, clear escalation |
| **Privacy breach** | Catastrophic | Low | RLS, audit logging, penetration testing, encryption |
| **LLM hallucination** | High | Medium | Verification loops, fact-checking, tool use validation |
| **User dependence** | High | Medium | Character design (animal, not human), therapy referrals |
| **Cost overrun** | High | Medium | Budgeting, light context mode, monitoring, rate limiting |
| **Low engagement** | High | Medium | Character quality, proactive value, user feedback iteration |
| **Regulatory compliance** | High | Low | Legal review, compliance features (GDPR, HIPAA) |
| **Technical scalability** | Medium | Medium | Load testing, horizontal scaling architecture, caching |
| **Therapeutic ineffectiveness** | Medium | Medium | Evidence-based approaches, clinical review, outcome tracking |
| **Character inconsistency** | Medium | Medium | Careful prompt engineering, testing, refinement |
| **AI-enabled self-harm** | Catastrophic | Low | Output filtering, crisis keywords trigger escalation path, no autonomous emergency contact; Adam Raine review checkpoint for all Phase 6+ features |
| **Medical data breach** | Catastrophic | Low | PHI isolated in encrypted fields, RLS enforced, no PHI in LLM prompts, GDPR/HIPAA export/delete endpoints, audit trail |
| **Prompt injection attack** | High | Medium | Injection pattern detection on all user input, sandboxed LLM execution context, output filtering before display/storage |

---

### Appendix F: Team & Skills Needed

**Core Team (Minimum Viable):**
- 1-2 Backend Developers (Python, FastAPI, PostgreSQL)
- 1 LLM/ML Engineer (prompt engineering, RAG, embeddings)
- 1 Frontend Developer (React, if building web UI)
- 1 Mental Health Consultant (therapist, psychologist for validation)
- 1 Product Manager / Designer (UX, user research)

**Extended Team (Scale-Up):**
- DevOps Engineer (infrastructure, monitoring)
- Security Engineer (penetration testing, compliance)
- Data Scientist (signal analysis, outcome measurement)
- Mobile Developers (iOS, Android apps)
- Community Manager (user support, feedback)

**Key Skills:**
- Python async programming
- LLM API integration & prompt engineering
- Vector search & RAG systems
- PostgreSQL & database design
- Mental health domain knowledge (ADHD, depression, agoraphobia)
- Security & privacy best practices
- User research & feedback integration

---

## Conclusion

This roadmap provides a comprehensive, step-by-step plan to build Familiar from foundation to production. It incorporates all research findings, prioritizes safety and wellbeing, and maintains focus on the core vision: **an agentic caretaker that helps users with mental health conditions thrive.**

**Key Principles to Remember:**
1. **User safety first** - Crisis detection and intervention are non-negotiable
2. **Character consistency** - The animal persona is what makes this work
3. **Evidence-based interventions** - All therapeutic approaches backed by research
4. **Privacy by design** - Multi-user relay requires robust permission system
5. **Proactive, not reactive** - Heartbeat mechanic transforms AI from tool to companion
6. **Agency, not dependence** - Support user's autonomy and growth
7. **Iterative refinement** - Alpha testing and user feedback are critical

**Estimated Timeline:** 6-8 months from Phase 0 to Phase 8 completion (with a team of 3-5 people)

**Next Steps:**
1. Review this roadmap with team/stakeholders
2. Confirm architecture decisions (Phase 0)
3. Set up development environment (Phase 0)
4. Begin Phase 1 implementation

Good luck building Familiar! 🐾
