# System Design Interview Questions

Common questions interviewers ask about multi-tenant SaaS systems, with frameworks for structuring your answers.

---

## Before You Answer

**Structure every answer in 3 layers:**

1. **Problem Statement** — Why you made each choice
2. **Solution** — Your approach with trade-offs
3. **Example** — Walk through a specific scenario

**Keep it conversational** — Your interviewer will interrupt with follow-ups. Be ready for deeper questions.

---

## Question 1: Design a Multi-Tenant Database

### What They're Testing

- Understanding of data isolation
- Awareness of performance implications
- Knowledge of practical constraints

### Framework Answer

**Problem Statement (30 seconds)**

> "Multi-tenancy is about isolating data across customers while minimizing infrastructure costs. The key tension is between isolation strength and operational complexity."

**Solution (2 minutes)**

> "I'd use a shared schema with row-level filtering. Here's why:

> **Schema Design:**
>
> - One database with shared tables
> - Every row includes `tenant_id`
> - Composite primary keys: `(tenant_id, id)` where possible
> - Composite foreign keys to enforce tenant boundaries

> **Example:**
>
> ```sql
> CREATE TABLE tenants (id UUID PRIMARY KEY);
> CREATE TABLE bookings (
>   id UUID,
>   tenant_id UUID NOT NULL REFERENCES tenants(id),
>   customer_id UUID NOT NULL,
>   PRIMARY KEY (tenant_id, id),
>   FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
> );
> ```

> **Isolation:**
>
> - Every query includes WHERE tenant_id = ?
> - Index on (tenant_id, field) prevents seq scans
> - Never trust tenant_id from client, always from JWT

> **Trade-offs:**
>
> - Pro: Operational simplicity, low cost
> - Con: Requires discipline on query filtering
> - Mitigation: Code review checklist, automated tests"

**Example Scenario (1 minute)**

> "Walk through a booking creation:
>
> 1. Client makes POST /bookings with JWT containing tenant_id: 'A'
> 2. Server extracts tenant_id from JWT (never from body)
> 3. INSERT INTO bookings (id, tenant_id, customer_id, ...) VALUES (?, 'A', ?, ...)
> 4. Query later filters: SELECT \* FROM bookings WHERE tenant_id = 'A'
> 5. If user manually tried to query tenant_id = 'B', they get 403 Forbidden"

### Follow-Up Questions You Might Get

**Q: What if you need complete isolation?**

> "Separate database per tenant. Trade-offs: operational burden (N databases, N migrations, N backups), but maximum isolation. You'd pick this for high-security requirements or regulatory needs."

**Q: How do you handle reporting across tenants?**

> "Analytics database (data warehouse) with ETL pipeline. Pull anonymized, aggregated data into separate system. Keeps operational DB pure."

**Q: What about scaling to millions of tenants?**

> "Shared schema stays the same. Scaling happens horizontally (more app instances), database via read replicas and sharding by tenant_id if needed."

---

## Question 2: How Do You Prevent Tenant Data Leaks?

### What They're Testing

- Security mindset
- Attention to detail
- Defense in depth thinking

### Framework Answer

**Problem Statement (30 seconds)**

> "Data leaks are existential threats to SaaS. You need multiple layers of protection, not just one."

**Solution: Defense in Depth (3 minutes)**

**Layer 1: Query-Time Filtering**

```typescript
const booking = await db
  .select()
  .from(bookingsTable)
  .where(
    and(
      eq(bookingsTable.id, bookingId),
      eq(bookingsTable.tenantId, tenantId), // EVERY query
    ),
  );
```

**Layer 2: Trusted Tenant Context**

```typescript
// ✅ Correct — from JWT
const tenantId = req.user.tenantId;

// ❌ Wrong — from client
const tenantId = req.body.tenantId;
```

**Layer 3: Database Constraints**

```sql
-- Composite foreign key prevents cross-tenant refs
FOREIGN KEY (tenant_id, customer_id)
REFERENCES customers(tenant_id, id)
```

**Layer 4: Explicit HTTP Authorization**

```typescript
// After query succeeds, verify tenant matches
if (booking.tenantId !== tenantId) {
  throw new ForbiddenException();
}
```

**Layer 5: Audit Logging**

```sql
INSERT INTO audit_logs (tenant_id, user_id, action, resource_id)
VALUES (tenantId, userId, 'READ_BOOKING', bookingId);
```

**How they work together:**

- Query filtering catches most bugs
- Trusted context prevents client manipulation
- DB constraints catch cross-tenant refs
- HTTP checks catch edge cases
- Audit logs reveal attacks

### Example: The Attack

> "Attacker tries: GET /api/bookings?tenant_id=evil&id=123
>
> 1. Server extracts tenant_id from JWT: 'attacker'
> 2. Query: SELECT \* FROM bookings WHERE id = '123' AND tenant_id = 'attacker'
> 3. Result: Empty (booking 123 belongs to 'victim')
> 4. If filtering was wrong, they'd see it, but HTTP check catches it
> 5. Audit log shows: ['attacker', 'attempted_unauthorized_access', '123']"

### Follow-Up Questions

**Q: What if there's a bug and filtering is missing?**

> "Composite keys catch it. If you try to create a booking with (tenant_a, staff_b) where staff_b belongs to tenant_c, the FK constraint fails."

**Q: How do you test for leaks?**

> "Integration test with 2 tenants. Create record in A, query as B, assert returns empty."

---

## Question 3: Explain Your Scaling Strategy

### What They're Testing

- Systems thinking
- Performance awareness
- Practical constraints

### Framework Answer

**Problem Statement (30 seconds)**

> "Scaling a multi-tenant system means scaling horizontally (more servers) while keeping shared resources (database) manageable."

**Solution: Three Levels (3 minutes)**

**Level 1: Application Layer (Easiest)**

```
No changes needed for multi-tenancy.
Deploy more instances, load balance requests.
Each instance connects to same database.
Session state is JWT-based, so sessions don't "stick" to one server.
```

**Level 2: Caching Layer (When Needed)**

```
Add Redis with tenant-scoped keys.

❌ Key: "user:123" → collision if tenant A and B both have user 123
✅ Key: "user:tenant-a:123" → unique per tenant

Cache warming: "user:*:123" pattern at startup
Invalidation: On write, delete "user:*:*" for that tenant
```

**Level 3: Database Layer (When It Matters)**

```
Read replicas:
  - Primary: handle writes
  - Replicas: handle reads
  - All queries filtered by tenant_id, so replicas serve all tenants

Indexes on (tenant_id, field):
  - Prevents sequential scans on large tables
  - Makes tenant-scoped queries fast

Connection pooling:
  - PgBouncer or similar
  - Shared across tenants (one pool per server)
  - Scales to thousands of concurrent users
```

**Level 4: Storage Sharding (Advanced, Optional)**

```
If one tenant is massive (1% of tenants = 99% of data):

Shard by tenant_id:
  - Tenant A → Database 1
  - Tenant B → Database 2
  - Others → Database 3

Write amplification:
  - Router needs to know which shard
  - Cross-tenant queries become impossible
  - Only for extreme cases
```

### Example Scenario

> "Imagine 10,000 concurrent users across 100 tenants:
>
> 1. **App Layer:** Deploy 10 instances (each handles ~1000 users)
> 2. **Load Balancer:** Round-robin across 10 instances
> 3. **Cache:** Each instance queries Redis once per hour for config
> 4. **Database:** 1 primary, 2 read replicas, shared connection pool
> 5. **Indexes:** (tenant_id, created_at) prevents table scans
> 6. **Result:** Handles 10k users with one DB
>
> If one tenant becomes massive (5000 users), we shard that tenant's data separately."

### Follow-Up Questions

**Q: How many tenants fit in one database?**

> "Depends on data volume and query patterns. Our production system handles 500+ tenants in one DB. Limiting factor is usually disk space and query complexity, not tenant count."

**Q: How do you migrate a tenant to a separate database?**

> "Background job: read from shared DB, write to tenant's new DB. Switch router. Delete from shared DB. Rollback just points router back to shared DB."

---

## Question 4: How Would You Handle Multi-Region Deployment?

### What They're Testing

- Global systems thinking
- Complexity management
- Trade-off awareness

### Framework Answer

**Problem Statement (30 seconds)**

> "Multi-region adds latency and complexity but improves availability and compliance."

**Solution: Approaches (2 minutes)**

**Approach 1: Replicate Globally (Simple)**

```
- Primary database: US-East
- Read replicas: EU, Asia, Australia
- Users in any region read from nearest replica
- Writes always go to primary (with ~100ms latency)
- Great for read-heavy systems
```

**Approach 2: Regional Databases (Complex)**

```
- Each region has primary + replicas
- Tenant "home region" defined at signup
- Data replicates between regions asynchronously
- Writes are fast everywhere (local primary)
- Trade-off: eventual consistency, complexity
```

**Approach 3: Regional Shard (Best for Some)**

```
- Shard by geography
- Tenant A → US database
- Tenant B → EU database
- Complete isolation per region
- Trade-off: can't query across regions easily
```

**For this project:** Approach 1 (replicate globally)

> "We use read replicas in multiple regions with local latency routing. Cross-region failover is automatic."

---

## Question 5: How Do You Handle Soft Deletes Across Tenants?

### Framework Answer

**Problem Statement (30 seconds)**

> "Soft deletes let you retain data for audits/recovery but complicate queries."

**Solution: Tenant-Scoped Soft Deletes (2 minutes)**

**Schema:**

```sql
CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  deleted_at TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
```

**Queries Always Include Both Filters:**

```typescript
const active = await db
  .select()
  .from(bookingsTable)
  .where(
    and(
      eq(bookingsTable.tenantId, tenantId),
      isNull(bookingsTable.deletedAt), // ← Don't forget this!
    ),
  );
```

**Soft Delete:**

```typescript
await db
  .update(bookingsTable)
  .set({ deletedAt: new Date() })
  .where(
    and(eq(bookingsTable.id, bookingId), eq(bookingsTable.tenantId, tenantId)),
  );
```

**Hard Delete (Admin Only):**

```typescript
// After 90 days
await db
  .delete(bookingsTable)
  .where(
    and(
      eq(bookingsTable.tenantId, tenantId),
      lt(bookingsTable.deletedAt, DateTime.now().minus({ days: 90 })),
    ),
  );
```

---

## Question 6: Permission System Design

### Framework Answer

**Problem Statement (30 seconds)**

> "Permissions need to be fine-grained but queryable efficiently."

**Solution: RBAC with Caching (2 minutes)**

**Data Model:**

```sql
CREATE TABLE roles (id UUID, tenant_id UUID, name VARCHAR);
CREATE TABLE permissions (id UUID, name VARCHAR); -- Global
CREATE TABLE role_permissions (role_id UUID, permission_id UUID);
CREATE TABLE user_roles (user_id UUID, tenant_id UUID, role_id UUID);
```

**Check Permission:**

```typescript
async function hasPermission(userId, tenantId, permission) {
  // 1. Check cache
  const cached = redis.get(`perms:${userId}:${tenantId}`);
  if (cached) return cached.includes(permission);

  // 2. Query database
  const roles = await db.select()
    .from(userRolesTable)
    .where(and(
      eq(userRolesTable.userId, userId),
      eq(userRolesTable.tenantId, tenantId)
    ));

  // 3. Fetch permissions for those roles
  const permissions = await db.select()...;

  // 4. Cache result
  redis.set(`perms:${userId}:${tenantId}`, permissions, EX: 3600);

  return permissions.includes(permission);
}
```

**Hierarchy:**

```
Admin
  ├─ Staff (inherits some Admin perms)
  │   ├─ Regular (inherits some Staff perms)
  │   └─ Manager
  └─ Guest (minimal perms)
```

---

## General Interview Tips

### Before the Interview

1. **Know your own system** — Be specific about your choices
2. **Prepare examples** — Have concrete scenarios ready
3. **Know the trade-offs** — Every choice sacrifices something
4. **Practice explaining** — Can you explain this to a non-engineer?
5. **Research the company** — What are their scaling challenges?

### During the Interview

1. **Think out loud** — "I'm considering X vs Y because..."
2. **Ask clarifying questions** — "What's our scale? Budget? Compliance?"
3. **Draw diagrams** — Boxes, arrows, data flow
4. **Use examples** — Specific numbers and scenarios
5. **Admit unknowns** — "That's a great question, I'd need to research..."
6. **Show reasoning** — Why, not just what

### After Follow-Ups

1. **Listen to hints** — They might say "actually, we have 100k QPS"
2. **Adapt your answer** — Change scale/approach based on feedback
3. **Ask counter-questions** — "What would you do differently?"
4. **Offer alternatives** — "Another approach would be..."

---

## System Design Question Checklist

For any design question, cover these:

- [ ] **Problem statement** — What's the constraint?
- [ ] **Scale** — How many users/tenants/requests?
- [ ] **Data model** — How do you store it?
- [ ] **Query patterns** — What reads/writes happen?
- [ ] **Isolation** — How do you prevent data leaks?
- [ ] **Performance** — What's your latency target?
- [ ] **Scaling** — How does it grow?
- [ ] **Trade-offs** — What did you sacrifice?
- [ ] **Monitoring** — How do you know it works?
- [ ] **Disaster recovery** — What's your failover?

---

## Resources

- **Live System Examples:** [Implementation Examples](../05-implementation/)
- **Scaling Strategies:** [Scaling & Performance](../08-scaling-performance/)
- **Security Deep Dive:** [Security & Isolation](../04-security-isolation/)
- **Real Code:** [Check the repository](https://github.com/yourusername/donebyme)

---

**Last updated:** 2025-01-15
Ready? Practice these until they feel natural.
