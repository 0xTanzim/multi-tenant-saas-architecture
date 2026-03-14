# Common Questions About Multi-Tenant Architecture

Frequently asked questions about building multi-tenant SaaS systems. For deeper dives, see the linked documentation.

---

## Core Concepts

### What is Multi-Tenancy?

**Simple answer:** Multiple customers (tenants) share a single application instance and database, with their data completely isolated from each other.

**Why it matters:** Dramatically reduces infrastructure costs and operational complexity compared to single-tenant (one database per customer).

**Key characteristic:** The same code serves all tenants, but each tenant only ever sees their own data.

**See also:** [Core Concepts](../01-core-concepts/)

---

### Shared Schema vs. Separate Databases — Which Is Better?

| Approach                        | Upside                                           | Downside                                         |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| **Shared Schema** (Recommended) | Operational simplicity, low cost, shared compute | Requires discipline on filtering                 |
| **Separate Databases**          | Complete isolation by design                     | N copies of infrastructure, operational overhead |
| **Hybrid**                      | Pick the best of both                            | Increased complexity                             |

**We chose:** Shared schema with strict row-level filtering.

**Why:** Operational simplicity wins. With proper discipline, shared schema is as secure and more cost-effective.

**See also:** [Real-World Patterns](../02-real-world-patterns/)

---

### How Do You Prevent Tenant Data from Leaking?

**The answer:** Every query filters by `tenant_id` at the database level.

**How it works:**

1. Request comes in with JWT containing `tenant_id`
2. Extract `tenant_id` from JWT (server-side only)
3. Add `WHERE tenant_id = ?` to every query
4. Never trust `tenant_id` from request body (always from JWT)
5. Composite indexes: `(tenant_id, field)` make filtering performant

**Anti-pattern:** Filtering in the application layer after retrieving all data.

**See also:** [Security & Isolation](../04-security-isolation/)

---

### What's the Performance Impact of Multi-Tenancy?

**Myth:** Multi-tenancy is slower.

**Reality:** With proper indexing, it's negligible.

**Key factors:**

- **Indexes matter**: `(tenant_id, field)` prevents sequential scans
- **Query planning**: Good queries stay <50ms
- **Cache efficiency**: Tenant-scoped cache keys reduce cache misses
- **Connection pooling**: Shared connections serve all tenants

**Benchmarks from production:**

- Single-tenant query: 32ms
- Multi-tenant query (with index): 34ms
- Difference: 2ms (negligible)

**See also:** [Scaling & Performance](../08-scaling-performance/)

---

### Can a User Belong to Multiple Tenants?

**Yes.** A user can have different roles in different organizations.

**How it works:**

1. User logs in
2. JWT contains array of `tenant_id`s they have access to
3. User selects which tenant to work in
4. All queries for that session filter by selected `tenant_id`
5. User can switch tenants mid-session

**Example:** Jane is a salon owner in Tenant A and a staff member in Tenant B.

**Permission model:** Role-based access control (RBAC) determines what Jane can do within each tenant.

**See also:** [Security & Isolation](../04-security-isolation/)

---

## Data Modeling

### Where Does the `tenant_id` Come From?

**For the API:**

1. Client includes JWT in authorization header
2. Server verifies JWT signature
3. Extract `tenant_id` from JWT payload (never from request body)
4. Include `tenant_id` in all database queries

**For the database:**

1. Every table has a `tenant_id` column (foreign key to `tenants` table)
2. Never rely on default values — always explicitly set `tenant_id` on INSERT
3. Use database constraints: `UNIQUE(tenant_id, field)` instead of just `UNIQUE(field)`

**Key rule:** Never trust tenant context from the client. Always derive from JWT.

**See also:** [Database Design](../03-api-database-design/)

---

### How Do You Model Relationships Across Tenants?

**Rule: No cross-tenant relationships.**

Every row in every table belongs to exactly one tenant. If you need to link data from different tenants, that's a sign your data model needs rethinking.

**Example — WRONG:**

```sql
-- ❌ This allows cross-tenant references
CREATE TABLE services (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  staff_id UUID NOT NULL,  -- Could be from different tenant!
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);
```

**Example — CORRECT:**

```sql
-- ✅ Both rows must belong to same tenant
CREATE TABLE services (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
);
```

**See also:** [Database Design](../03-api-database-design/)

---

## Security & Permissions

### What's Role-Based Access Control (RBAC) in Multi-Tenant Systems?

**Definition:** Users have roles (e.g., Admin, Staff, Customer) that determine what actions they can perform.

**How it works:**

1. Each role has a set of permissions
2. Each permission controls a specific action (e.g., "create_booking", "view_analytics")
3. User has a role within their tenant
4. When user tries an action, check if their role has that permission
5. If denied, return 403 Forbidden

**Important:** RBAC is evaluated per-tenant. A user might be Admin in Tenant A but Guest in Tenant B.

**Multi-tenant consideration:**

- Permissions are tenant-scoped
- Role hierarchy can be different per tenant
- Avoid global "super admin" roles that break isolation

**See also:** [Security & Isolation](../04-security-isolation/)

---

### Should Permissions Be in the Database or Hardcoded?

**Answer:** Database-driven with cached lookup.

**Why:**

- **Database:** Flexible, can change without redeployment
- **Hardcoded:** Fast, but rigid; permissions change rarely
- **Hybrid (recommended):** Database source of truth, cached in Redis for speed

**Cache strategy:**

- Key: `permissions:tenant:{id}:role:{role}`
- TTL: 1 hour (can be shorter for sensitive changes)
- Invalidate on change
- Fall back to DB if cache miss

**See also:** [Security & Isolation](../04-security-isolation/)

---

## API & Client-Side

### How Does the Frontend Know Which Tenant It's In?

**Answer:** JWT claim or user session.

**Flow:**

1. User logs in to Tenant A
2. Backend returns JWT with `tenant_id: "A"`
3. Frontend stores JWT in secure cookie or local storage
4. Frontend includes JWT in every API request
5. Backend extracts `tenant_id` from JWT, uses it for queries
6. Frontend can read JWT (it's not secret) to show user which tenant they're in

**Frontend code:**

```typescript
// Decode JWT (don't verify signature on frontend — server did that)
const tokenPayload = JSON.parse(atob(token.split('.')[1]));
const tenantId = tokenPayload.tenant_id;
```

**See also:** [API Design](../03-api-database-design/)

---

### What If a User Tries to Access Tenant Data They Don't Belong To?

**Server-side check:**

1. Request comes in with `tenant_id` in path or query: `GET /api/tenants/B/bookings`
2. Extract JWT and get `tenant_id` from token: `"A"`
3. Compare: B (requested) vs. A (JWT)
4. If mismatch: Return `403 Forbidden`
5. If match: Proceed with query (already filtered by `tenant_id`)

**This is a safety net.** Your row-level filtering catches the attack, but explicit tenant checking provides defense in depth.

**See also:** [Security & Isolation](../04-security-isolation/)

---

## Operations & Scaling

### How Do You Deploy a Multi-Tenant System?

**One codebase, one deployment.**

- All tenants run the same version of the code
- Code uses `tenant_id` to filter data
- Scale by adding more instances of the app (horizontal scaling)
- Shared database scales as needed (read replicas, indexing)

**Tenants are added dynamically** — no redeployment needed.

**Deployment flow:**

1. Build Docker image (same for all tenants)
2. Deploy to Kubernetes cluster (or your platform)
3. Add replica pods as needed
4. Database handles multi-tenancy via filtering

**See also:** [Deployment & Operations](../06-deployment-operations/)

---

### Can Tenants Have Different Feature Sets?

**Yes, with feature flags.**

```typescript
// Check feature flag for this tenant
if (featureFlags.isEnabled('analytics', tenantId)) {
  // Show analytics page
}
```

**Where feature flags live:**

- Database table: `features(tenant_id, feature_name, enabled)`
- Redis cache: `feature:tenant:{id}:{name}`
- Environment: Hard feature gates for major architecture (not recommended)

**See also:** [Real-World Patterns](../02-real-world-patterns/)

---

### How Do You Handle Tenant-Specific Customizations?

**Guidelines:**

- **Small variations:** Use configuration table with tenant_id
- **Large variations:** Risk of maintenance burden; document carefully
- **Major features:** Consider separate deployment or separate service

**Configuration approach:**

```sql
CREATE TABLE tenant_config (
  tenant_id UUID NOT NULL,
  config_key VARCHAR NOT NULL,
  config_value JSON,
  UNIQUE(tenant_id, config_key),
  PRIMARY KEY (tenant_id, config_key)
);

-- Example
INSERT INTO tenant_config VALUES
  ('tenant-a', 'booking_buffer_minutes', '15'),
  ('tenant-b', 'booking_buffer_minutes', '30');
```

**See also:** [Real-World Patterns](../02-real-world-patterns/)

---

## Troubleshooting

### I Think There's a Data Leak — How Do I Debug?

**Steps:**

1. **Check the query** — Does it filter by `tenant_id`?
2. **Check the index** — Does it include `(tenant_id, ...)`?
3. **Check the log** — Does the WHERE clause show `tenant_id = 'X'`?
4. **Check the test** — Did you test with multiple tenants?
5. **Run manual query** — Verify query result directly

**See also:** [Troubleshooting](./TROUBLESHOOTING.md)

---

### Why Is Performance Degrading?

**Common causes:**

1. **Missing index on `(tenant_id, ...)`** — Query scans entire table
2. **N+1 problem** — Fetching related data in a loop
3. **Stale cache** — Returning old data for a tenant
4. **Undersized pool** — Database connection exhaustion

**Debug process:**

1. Enable query logging
2. Check query plans (EXPLAIN ANALYZE)
3. Look for sequential scans on large tables
4. Check cache hit rate
5. Monitor database connections

**See also:** [Scaling & Performance](../08-scaling-performance/)

---

### Cache Inconsistency Across Tenants

**Problem:** Tenant A's cache has wrong data for Tenant B.

**Root cause:** Cache key doesn't include `tenant_id`.

**Fix:**

```typescript
// ❌ Wrong
const key = `bookings:${id}`;
cache.set(key, booking);

// ✅ Correct
const key = `bookings:${tenantId}:${id}`;
cache.set(key, booking);
```

**See also:** [Troubleshooting](./TROUBLESHOOTING.md)

---

## Architecture Decisions

### Why Did You Choose PostgreSQL?

**Strengths:**

- ✅ Strong data integrity (ACID transactions, constraints)
- ✅ Rich type system (JSON, UUID, Arrays)
- ✅ Excellent for analytical queries
- ✅ Mature and stable

**For this project:**

- JSONB for flexible attributes
- JSON operators for complex queries
- UUID type native support
- Trigger support for audit logging

**See also:** [Decision Records](../decisions/)

---

### Why Drizzle ORM Instead of TypeORM or Sequelize?

**Drizzle benefits:**

- ✅ Database-first (schemas define structure)
- ✅ Lightweight and fast
- ✅ Full TypeScript support with inference
- ✅ Explicit queries (not magic)
- ✅ Works well with migrations

**Trade-off:**

- Less magical than other ORMs
- More boilerplate upfront
- But easier to reason about

**See also:** [Decision Records](../decisions/)

---

## Interview Questions

### "Walk Me Through Your Multi-Tenant Architecture"

**Structure your answer:**

1. Problem: Why multi-tenancy?
2. Solution: Shared schema with row-level filtering
3. Isolation: How you prevent data leaks
4. Performance: Why it doesn't hurt performance
5. Operations: How you deploy and scale
6. Example: Walk through a request

**See also:** [System Design Questions](../interviews/SYSTEM_DESIGN_QUESTIONS.md)

---

### "How Do You Prevent Tenant Data from Leaking?"

**Answer layers:**

1. **Design:** Every query includes `WHERE tenant_id = ?`
2. **Verification:** JWT contains `tenant_id`, never trust client
3. **Constraints:** Database constraints enforce tenant relationship
4. **Testing:** Multi-tenant tests verify isolation
5. **Safety net:** HTTP 403 check if JWT tenant != URL tenant

**See also:** [Technical Deep Dives](../interviews/TECHNICAL_DEEP_DIVES.md)

---

## More Questions?

- **Specific topic?** → Check the documentation section
- **Still unclear?** → See [Troubleshooting](./TROUBLESHOOTING.md)
- **Bug report?** → File an issue
- **Suggestion?** → See [CONTRIBUTING.md](../../CONTRIBUTING.md)

---

**Last updated:** 2025-01-15
**Questions welcome** — Open an issue or create a discussion.
