# ADR-001: Shared Schema with Row-Level Tenant Isolation

**Status:** Accepted
**Date:** 2025-05-10
**Audience:** Architects, Backend Engineers, Platform Decision-Makers
**Supersedes:** None
**Superseded By:** None

---

## Decision

We will use a **shared PostgreSQL schema with row-level tenant isolation** (single database, single schema, all tenants' data in shared tables distinguished by `tenant_id` column) rather than adopting either database-per-tenant or separate infrastructure approaches.

---

## Context

The multi-tenant SaaS platform serves multiple independent customers (salon owners, customers, staff) through a single application deployment. A foundational architectural decision was required to determine how tenant data would be isolated in the database.

Three primary isolation models exist in the SaaS industry:

1. **Shared Schema (Row-Level Isolation):** Single database, shared schema, `tenant_id` filtering
2. **Database-Per-Tenant:** Separate PostgreSQL database for each tenant
3. **Separate Infrastructure:** Dedicated infrastructure (servers, DBs, networks) per tenant

This decision affects security guarantees, operational complexity, scalability, cost structure, and regulatory compliance capabilities. The choice made here influences all downstream architectural decisions (caching strategy, query patterns, deployment topology, audit logging).

---

## Options Considered

### Option A: Shared Schema (Row-Level Isolation) ✓ CHOSEN

**Description:**
Single PostgreSQL database and schema. All tenants' data stored in shared tables. Tenant identity enforced via `tenant_id` column on every row. Isolation achieved through application-layer filtering on all queries.

**Schema Example:**

```sql
CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,  -- Tenant identifier
  customer_id UUID NOT NULL,
  service_id UUID NOT NULL,
  booking_date DATE NOT NULL,
  status VARCHAR(50) NOT NULL,
  created_at TIMESTAMP NOT NULL
);

-- Composite index: most queries will filter tenant_id first
CREATE INDEX idx_bookings_tenant_date
  ON bookings(tenant_id, booking_date DESC);
```

**Query Pattern:**

```sql
-- Every query must include tenant filter
SELECT * FROM bookings
WHERE tenant_id = $1 AND booking_date >= $2;
```

**Pros:**

- ✅ **Lowest operational overhead:** Single database to manage, patch, backup
- ✅ **Instant tenant onboarding:** No schema provisioning delays; register tenant → immediately usable
- ✅ **Best resource efficiency:** Minimal overhead per tenant; database resources amortized across all
- ✅ **Simplified maintenance:** Security updates, migrations, point-in-time recovery unified
- ✅ **Cost-effective:** Lower database hosting costs (single instance vs. many)
- ✅ **Reasonable performance:** For small-to-medium tenants, negligible difference from dedicated DB

**Cons:**

- ❌ **Requires discipline:** Missing `tenant_id` filter in one query = data leakage across tenants
- ❌ **No schema customization:** All tenants forced to use identical schema
- ❌ **Noisy neighbor risk:** Runaway query from one tenant can degrade performance for all
- ❌ **GDPR complexity:** Right-to-be-forgotten requires surgical deletions across many tables
- ❌ **Performance unpredictability:** Shared resources mean tenant activity directly impacts others

---

### Option B: Database-Per-Tenant

**Description:**
Each tenant provisioned with their own PostgreSQL database (same schema). Logical isolation achieved through database-level separation.

**Topology:**

```
PostgreSQL Cluster
├── tenant_1_db
│   ├── bookings, customers, staff, services...
├── tenant_2_db
│   ├── bookings, customers, staff, services...
└── tenant_3_db
    ├── bookings, customers, staff, services...
```

**Pros:**

- ✅ Strong isolation: Hardware/software failure in one DB doesn't affect others
- ✅ GDPR compliance: Entire tenant deletion = drop database (atomic, clean)
- ✅ Custom schema per tenant: Large customers can extend schema without affecting others
- ✅ Performance isolation: Each tenant's query load independent
- ✅ Audit simplicity: Tenant operations naturally scoped to one database

**Cons:**

- ❌ Operational complexity: Manage N databases (backup, patch, monitoring, recovery)
- ❌ Provisioning delays: New tenant registration requires DB provisioning, schema initialization (minutes/hours)
- ❌ Higher database licensing costs: Multiple PostgreSQL instances
- ❌ Scaling limits: Cluster cannot grow linearly; diminishing returns beyond 100s of tenants
- ❌ Deployment overhead: Connection pooling, migration orchestration per DB
- ❌ Maintenance burden: Security patches must roll across all tenant DBs

**When to use:** Enterprise customers with strict compliance/isolation requirements (regulatory mandate), or when tenant data models are fundamentally different.

---

### Option C: Separate Infrastructure

**Description:**
Each tenant provisioned with dedicated infrastructure: servers, databases, networks, object storage. Complete physical isolation.

**Topology:**

```
Infrastructure as Code
├── Tenant 1
│   ├── Docker Compose, PostgreSQL, Redis, S3-like storage
│   ├── Isolated network (VPC)
│   └── Separate CI/CD pipeline
├── Tenant 2
│   ├── Docker Compose, PostgreSQL, Redis, S3-like storage
│   └── Isolated network (VPC)
└── ...
```

**Pros:**

- ✅ Maximum isolation: No shared infrastructure, no noisy neighbor risk
- ✅ Full customization: Each tenant can use different tech stack, DB versions, custom patches
- ✅ Regulatory/compliance: Easily satisfies HIPAA, PCI-DSS, SOC 2 Type II
- ✅ Audit simplicity: All logs, backups, recovery scoped to single tenant

**Cons:**

- ❌ **Operational nightmare:** Deploy & manage infrastructure for each new tenant
- ❌ **Cost prohibitive:** Full stack resources per tenant (not viable for <1000/month customers)
- ❌ **Scaling limits:** Practically limited to <100s of high-value customers
- ❌ **Update complexity:** Patch/feature rollout requires orchestrating across all tenant deployments
- ❌ **DevOps burden:** Massive increase in deployment, monitoring, incident management
- ❌ **Not viable for SaaS model:** Contradicts economies of scale that SaaS enables

**When to use:** Only for white-label solutions serving enterprise customers with dedicated contracts (e.g., Stripe Connect for large enterprise partners).

---

## Chosen Option

**Shared Schema with Row-Level Isolation (Option A)**

### Rationale

1. **Startup/Growth-Stage Alignment:** DoneByMe is a growing salon SaaS serving 100s-1000s of customers. Database-per-tenant overhead and separate infrastructure are premature.

2. **Operational Feasibility:** Single database deployment is maintainable by a small-to-medium backend team. No need for sophisticated database orchestration, connection pooling complexity.

3. **Cost Structure:** Shared schema enables profitable small-business pricing (e.g., $29-99/month). Database-per-tenant would force higher pricing or eliminate profitability.

4. **Tenant Onboarding UX:** Registration is instant (no provisioning delays). Customers expect immediate account access post-signup.

5. **Suitable for DoneByMe's Domain:** Salon booking system has predictable, uniform data model across all tenants. No need for per-tenant customization.

6. **Tech Stack Maturity:** Composite indexes, query filtering, and role-based access are well-understood patterns; minimal technical risk.

7. **Mitigations Available:** Architecture discipline (code reviews for tenant filters), automated testing for isolation, and monitoring can mitigate the primary risks (data leakage, noisy neighbor).

---

## Trade-Offs

| Aspect            | Cost                                               | Benefit                                    |
| ----------------- | -------------------------------------------------- | ------------------------------------------ |
| **Isolation**     | Lower guarantees; relies on code discipline        | Simpler ops, faster onboarding             |
| **Performance**   | Shared resources; noisy neighbor risk              | Amortized costs; efficient resource use    |
| **Customization** | All tenants same schema                            | Unified data model; easier feature rollout |
| **Compliance**    | GDPR deletion is harder (must prune across tables) | Simplified backup, recovery, patching      |
| **Scalability**   | Hits ceiling at ~1000s tenants (single DB)         | Scales well for current growth trajectory  |

### Acceptance Criteria for This Trade-Off

To make this decision viable, the platform **must enforce:**

1. **Tenant Filter Discipline:** Every production query includes `WHERE tenant_id = ?`. Code review checklist enforces this. Automated tests verify isolation.

2. **Composite Indexes:** All frequently-queried columns indexed with `(tenant_id, other_columns)` to prevent cross-tenant slow queries.

3. **Monitoring & Alerting:** Query execution time tracked per tenant. Alerts if single tenant's query exceeds SLA.

4. **Audit Logging:** All data access logged with tenant context for security audits.

5. **Role-Based Access Control:** Application layer enforces user → tenant → resource ownership before data returned.

---

## Consequences

### Positive Consequences

✅ **Fast Deployment:** Platform deployed once; serves all tenants instantly.

✅ **Low Operational Overhead:** Backup, recovery, patching done once for all tenants.

✅ **Efficient Resource Usage:** Database resources shared; cost per tenant decreases as platform scales.

✅ **Feature Velocity:** New features tested once; roll out to all tenants simultaneously.

✅ **Onboarding Speed:** New tenant registration complete in seconds (no DB provisioning).

✅ **Clear Data Model:** Uniform schema across all tenants; easier for engineers to reason about.

### Negative Consequences

❌ **Data Leakage Risk:** One missed `tenant_id` filter = cross-tenant data exposure. Requires vigilance in code review.

❌ **Performance Unpredictability:** Tenant A's heavy queries can slow down Tenant B. Requires monitoring and potential query optimization.

❌ **GDPR Deletion Complexity:** Right-to-be-forgotten requires identifying and deleting data across many tables (not atomic).

❌ **Schema Rigidity:** Cannot easily support per-tenant customization without schema complexity.

❌ **Single Point of Failure:** Database failure impacts all tenants (though backup/recovery happens once).

❌ **Audit Trail Complexity:** GDPR audit requires reconstructing access across shared tables (more complex than single-tenant DB).

---

## Alternatives If This Changes

### Migration Path: Shared Schema → Database-Per-Tenant

If this decision needs to be revisited (e.g., as platform scales to 10,000+ tenants or compliance requirements tighten):

**Migration Strategy:**

1. **Phase 1 - Abstraction Layer (Backward Compatible)**

   - Create a database access layer that abstracts connection decisions
   - Decorate all repositories with tenant context
   - Code remains unchanged; connection logic becomes configurable

2. **Phase 2 - Gradual Migration**

   - Designate "pilot" tenants to migrate to dedicated DBs first
   - Run both models in parallel; gradually migrate others
   - Blue-green deployment approach

3. **Phase 3 - Data Migration**

   - ETL processes copy tenant data from shared schema to dedicated DBs
   - Validation confirms data integrity
   - Cutover: switch traffic to new DBs
   - Rollback window available if issues detected

4. **Phase 4 - Sundown Shared Schema**
   - Once all tenants migrated, decommission shared schema
   - Archive for historical audit compliance

**Estimated Effort:** 2-3 sprints (assuming dedicated engineering team)

**Risk Factors:** Data consistency during migration, customer communication about uptime, connection pooling changes

---

## Decision Log

**Approved by:** Architecture Review Board
**Approved Date:** 2025-05-10
**Implementation Started:** Q2 2025
**Related Issues:** ARCH-0001, ARCH-0002
**Related ADRs:** ADR-002 (Row-Level Filtering), ADR-003 (Caching Strategy)

---

## References

- [MULTI_TENANT_FUNDAMENTALS.md](../01-core-concepts/MULTI_TENANT_FUNDAMENTALS.md)
- [TENANT_ARCHITECTURE.md](../02-tenant-management/TENANT_ARCHITECTURE.md)
- Stripe Blog: "The Anatomy of Multi-Tenancy"
- AWS Well-Architected Framework: Multi-Tenancy
