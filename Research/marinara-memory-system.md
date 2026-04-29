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
