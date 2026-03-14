# Architectural Decision Records (ADRs)

Record of important architectural decisions made during system design.

## 5 Core ADRs

### 1. **ADR-001: Shared Schema Multi-Tenancy**

Decision to use shared PostgreSQL schema with row-level tenant_id filtering (vs separate databases).

- Tradeoffs: Simplicity vs isolation
- Performance implications
- Operational considerations

### 2. **ADR-002: Application-Level Tenant Isolation**

Application-enforced isolation (vs PostgreSQL RLS).

- Control and transparency
- Testing and debugging
- Performance characteristics

### 3. **ADR-003: JWT with Embedded Tenant ID**

Including tenant_id in JWT claims for request context.

- Efficiency vs complexity
- Trust boundaries
- Token validation

### 4. **ADR-004: Soft Deletes for Compliance**

Using deleted_at column for logical deletion.

- Audit trail requirements
- Data recovery capabilities
- Query complexity

### 5. **ADR-005: Redis Caching Strategy**

Tenant-aware Redis caching with namespace prefixing.

- Cache isolation
- Invalidation patterns
- Performance gains

## ADR Format

Each ADR contains:

- **Context**: Why the decision was needed
- **Options Considered**: Alternative approaches
- **Decision**: What was chosen
- **Consequences**: Tradeoffs and impacts
- **Verification**: How we validate the decision

## Reading Order

1. Read in order (ADR-001 through ADR-005)
2. Each builds on previous decisions
3. Understand rationale before implementing

## Key Insight

> These decisions form the foundation of the multi-tenant architecture. Understanding the "why" is critical for maintaining system integrity.

---

**When to Reference**: Use these when making new architectural decisions or explaining design choices to stakeholders.
