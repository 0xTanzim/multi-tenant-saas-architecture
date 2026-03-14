# Proposals & RFCs

Architectural proposals and Request for Comments (RFCs) that shaped the platform design.

## 5 Architectural RFCs

### 1. **RFC-001: Shared Schema Multi-Tenancy Architecture**

Proposal for shared PostgreSQL schema vs separate databases.

### 2. **RFC-002: Application-Level Tenant Isolation**

Decision to implement isolation at application level (not PostgreSQL RLS).

### 3. **RFC-003: JWT with Embedded Tenant Claims**

Architecture for embedding tenant_id in JWT tokens.

### 4. **RFC-004: Redis Caching with Tenant Namespacing**

Caching strategy for multi-tenant systems.

### 5. **RFC-005: Event-Driven Architecture for Cross-Domain Communication**

Async patterns for decoupled domain interactions.

## RFC Purpose

Each RFC documents:

- **Motivation**: Why this decision was needed
- **Proposed Solution**: Technical approach
- **Alternatives**: Options considered
- **Trade-offs**: What we gain/lose
- **Implementation Impact**: How it affects the codebase

## Reading Order

1. **System Designers**: RFC-001 → RFC-002 → others
2. **Architects**: Read all RFCs in order
3. **Feature Builders**: Read relevant RFC for your domain

## Decision Framework

How were these decisions made?

- Scalability: Can it handle 10,000+ tenants?
- Security: Does it maintain isolation?
- Performance: What are the tradeoffs?
- Operations: Can we maintain this?

---

**Related**: See `../10-decision-records/` for ADRs (executed decisions)
