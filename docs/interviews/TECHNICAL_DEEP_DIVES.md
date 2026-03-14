# Technical Deep Dives

Advanced questions and detailed answers for technical interviews. Go deeper on specific topics.

---

## Deep Dive 1: Permission System Architecture

### Question

> "Your permission system supports hierarchical RBAC. Walk me through how it handles inheritance."

### Detailed Answer

**Data Model:**

```sql
-- Permissions are global
CREATE TABLE permissions (
  id UUID PRIMARY KEY,
  name VARCHAR UNIQUE,
  description VARCHAR
);

-- Roles are tenant-specific
CREATE TABLE roles (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  name VARCHAR,
  UNIQUE(tenant_id, name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Many-to-many: roles to permissions
CREATE TABLE role_permissions (
  role_id UUID NOT NULL,
  permission_id UUID NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (permission_id) REFERENCES permissions(id)
);

-- Inheritance: a role can inherit from parent roles
CREATE TABLE role_hierarchy (
  parent_role_id UUID NOT NULL,
  child_role_id UUID NOT NULL,
  PRIMARY KEY (parent_role_id, child_role_id),
  FOREIGN KEY (parent_role_id) REFERENCES roles(id),
  FOREIGN KEY (child_role_id) REFERENCES roles(id)
);

-- User roles per tenant
CREATE TABLE user_roles (
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  role_id UUID NOT NULL,
  PRIMARY KEY (user_id, tenant_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

**Getting All Permissions for a User (Recursive Query):**

```sql
WITH RECURSIVE role_chain AS (
  -- Start with user's direct role
  SELECT role_id FROM user_roles
  WHERE user_id = $1 AND tenant_id = $2

  UNION ALL

  -- Recursively add parent roles
  SELECT rh.parent_role_id
  FROM role_hierarchy rh
  INNER JOIN role_chain rc ON rh.child_role_id = rc.role_id
)
SELECT DISTINCT p.name
FROM role_chain rc
INNER JOIN role_permissions rp ON rc.role_id = rp.role_id
INNER JOIN permissions p ON rp.permission_id = p.id;
```

**Caching Strategy:**

```typescript
async function getUserPermissions(userId: string, tenantId: string) {
  // Cache key includes tenant to prevent cross-tenant leaks
  const cacheKey = `perms:${userId}:${tenantId}`;

  // Try cache
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Cache miss: query database
  const permissions = await db.execute(/* recursive query above */);

  // Store in cache for 1 hour
  await redis.set(cacheKey, JSON.stringify(permissions), 'EX', 3600);

  return permissions;
}

// On permission change, invalidate cache
async function updateRolePermission(roleId: string, tenantId: string) {
  // ... update database ...

  // Invalidate cache for all users with this role
  const affectedUsers = await db
    .select()
    .from(userRoles)
    .where(eq(userRoles.roleId, roleId));

  for (const user of affectedUsers) {
    await redis.delete(`perms:${user.userId}:${tenantId}`);
  }
}
```

**Permission Check in Request Handler:**

```typescript
async function checkPermission(req: Request, permission: string) {
  const userId = req.user.id;
  const tenantId = req.user.tenantId;

  const permissions = await getUserPermissions(userId, tenantId);

  if (!permissions.includes(permission)) {
    throw new ForbiddenException(`Missing permission: ${permission}`);
  }
}

// Usage in route handler
app.post('/bookings', checkPermission('create_booking'), async (req) => {
  // User is guaranteed to have permission
  const booking = await createBooking(req.body);
});
```

### Follow-Up Questions You Might Get

**Q: What if we need dynamic permission checks (based on resource ownership)?**

> "We layer permission checks. First check role-based (can any Admin create bookings?), then check resource-based (is this booking for your tenant?). Example: 'Can I edit this booking?' = hasPermission('edit_booking') && booking.tenantId === userTenantId"

**Q: How do you prevent infinite loops in role inheritance?**

> "Add a UNIQUE constraint preventing cycles: `ALTER TABLE role_hierarchy ADD CONSTRAINT no_cycles CHECK (parent_role_id != child_role_id);`. For more complex cycles, add a recursive depth limit in the query: `WHERE depth < 10`"

**Q: What about permissions that change per-tenant?**

> "Some permissions are global (defined in the permissions table), others are tenant-specific. For tenant-specific permissions, we add a column: `permissions (id, name, tenant_id)`. A permission with tenant_id = NULL is global; with tenant_id = 'X' is only for that tenant."

---

## Deep Dive 2: Database Query Optimization for Multi-Tenancy

### Question

> "How do you prevent N+1 queries in a multi-tenant system?"

### Detailed Answer

**The Problem:**

```typescript
// ❌ N+1 Query Pattern
const bookings = await db
  .select()
  .from(bookingsTable)
  .where(eq(bookingsTable.tenantId, tenantId));

for (const booking of bookings) {
  booking.customer = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, booking.customerId));
  // ← One query per booking!
}

// If we have 100 bookings, that's 101 queries (1 + 100)
```

**The Solution: Use JOINs**

```typescript
// ✅ Single Query with JOIN
const bookings = await db
  .select()
  .from(bookingsTable)
  .leftJoin(
    customersTable,
    and(
      eq(bookingsTable.customerId, customersTable.id),
      eq(customersTable.tenantId, tenantId), // ← Important! Filter customer too
    ),
  )
  .where(eq(bookingsTable.tenantId, tenantId));

// Returns: 100 queries worth of data in 1 query
```

**Why the tenant filter on JOIN matters:**

```sql
-- ❌ Without tenant filter on JOIN
SELECT b.*, c.*
FROM bookings b
LEFT JOIN customers c ON b.customer_id = c.id
WHERE b.tenant_id = 'A';

-- Customer c could be from any tenant!
-- If customer 123 exists in both Tenant A and B,
-- we might get the wrong one or both

-- ✅ With tenant filter on JOIN
SELECT b.*, c.*
FROM bookings b
LEFT JOIN customers c ON b.customer_id = c.id
  AND c.tenant_id = 'A'  -- ← Enforce tenant match
WHERE b.tenant_id = 'A';

-- Now customer 123 can only be from Tenant A
```

**Nested Relations (Multiple Levels):**

```typescript
// Multiple levels of relations
const bookings = await db
  .select()
  .from(bookingsTable)
  .leftJoin(
    customersTable,
    and(
      eq(bookingsTable.customerId, customersTable.id),
      eq(customersTable.tenantId, tenantId),
    ),
  )
  .leftJoin(
    staffTable,
    and(
      eq(bookingsTable.staffId, staffTable.id),
      eq(staffTable.tenantId, tenantId), // ← Tenant filter here too
    ),
  )
  .leftJoin(
    servicesTable,
    and(
      eq(bookingsTable.serviceId, servicesTable.id),
      eq(servicesTable.tenantId, tenantId), // ← And here
    ),
  )
  .where(eq(bookingsTable.tenantId, tenantId));

// One query, all relations loaded, all tenant-scoped
```

**When You Can't Use JOINs (Reporting Queries):**

```typescript
// Sometimes you need aggregates or complex logic
// Use batch loading instead of N+1

const bookingIds = bookings.map((b) => b.id);

// Fetch related data in bulk
const ratings = await db
  .select()
  .from(ratingsTable)
  .where(
    and(
      inArray(ratingsTable.bookingId, bookingIds),
      eq(ratingsTable.tenantId, tenantId),
    ),
  );

// Map by ID for fast lookup
const ratingsMap = new Map(ratings.map((r) => [r.bookingId, r]));

// Attach to bookings
bookings = bookings.map((b) => ({
  ...b,
  rating: ratingsMap.get(b.id),
}));

// 2 queries instead of N+1
```

**Index Strategy to Support These Queries:**

```sql
-- Support the JOIN pattern
CREATE INDEX idx_customers_tenant_id ON customers(tenant_id);
CREATE INDEX idx_bookings_tenant_customer ON bookings(tenant_id, customer_id);
CREATE INDEX idx_staff_tenant_id ON staff(tenant_id);

-- Without these indexes, the JOIN would scan entire tables
-- With these, it's a fast index lookup + filter
```

### Performance Impact

**Before optimization:**

- 100 bookings = 101 queries
- Total time: 3.2 seconds (30-50ms per query)

**After JOIN optimization:**

- 100 bookings = 1 query
- Total time: 45ms

**50x faster** just from eliminating N+1.

---

## Deep Dive 3: Tenant Data Isolation Vulnerabilities

### Question

> "What are the most common data isolation vulnerabilities you've seen?"

### Detailed Answer

**Vulnerability 1: Soft Delete Filter Missing**

```typescript
// ❌ Vulnerable
const bookings = await db
  .select()
  .from(bookingsTable)
  .where(eq(bookingsTable.tenantId, tenantId));

// If a booking was soft-deleted by another tenant,
// we still return it!

// ✅ Secure
const bookings = await db
  .select()
  .from(bookingsTable)
  .where(
    and(
      eq(bookingsTable.tenantId, tenantId),
      isNull(bookingsTable.deletedAt), // ← Don't forget!
    ),
  );
```

**Vulnerability 2: JOIN Filter Missing**

```typescript
// ❌ Vulnerable
const result = await db.query(
  `
  SELECT b.*, s.*
  FROM bookings b
  JOIN staff s ON b.staff_id = s.id
  WHERE b.tenant_id = $1
`,
  [tenantId],
);

// Staff member could be from another tenant!

// ✅ Secure
const result = await db.query(
  `
  SELECT b.*, s.*
  FROM bookings b
  JOIN staff s ON b.staff_id = s.id
    AND s.tenant_id = b.tenant_id
  WHERE b.tenant_id = $1
`,
  [tenantId],
);
```

**Vulnerability 3: Cache Key Collision**

```typescript
// ❌ Vulnerable
cache.set(`user:${userId}`, userData);
// If User 123 exists in both Tenant A and B,
// this key collides!

// ✅ Secure
cache.set(`user:${tenantId}:${userId}`, userData);
```

**Vulnerability 4: ORM Lazy Loading**

```typescript
// ❌ Vulnerable if getStaff() doesn't filter by tenant
const booking = await db
  .select()
  .from(bookingsTable)
  .where(eq(bookingsTable.tenantId, tenantId));

const staff = await booking.getStaff(); // Could be cross-tenant!

// ✅ Secure: explicit query
const staff = await db
  .select()
  .from(staffTable)
  .where(
    and(eq(staffTable.id, booking.staffId), eq(staffTable.tenantId, tenantId)),
  );
```

**Vulnerability 5: Trusting Client `tenant_id`**

```typescript
// ❌ Vulnerable
const tenantId = req.body.tenant_id; // Client controls this!

// ✅ Secure
const tenantId = req.user.tenantId; // From JWT, server-verified
```

**Vulnerability 6: Foreign Key Without Tenant Scope**

```sql
-- ❌ Vulnerable
ALTER TABLE bookings
ADD FOREIGN KEY (staff_id) REFERENCES staff(id);

-- staff_id could point to a staff member from another tenant!

-- ✅ Secure
ALTER TABLE bookings
ADD FOREIGN KEY (tenant_id, staff_id)
REFERENCES staff(tenant_id, id);

-- Now staff_id MUST be from the same tenant
```

### Testing for Vulnerabilities

```typescript
// Multi-tenant isolation test
describe('Tenant Isolation', () => {
  it('user from tenant A cannot see tenant B data', async () => {
    // Create data in Tenant A
    const bookingA = await createBooking({
      tenantId: 'A',
      description: 'Salon A booking',
    });

    // Create data in Tenant B
    const bookingB = await createBooking({
      tenantId: 'B',
      description: 'Salon B booking',
    });

    // Query as Tenant A
    const results = await getBookings({ tenantId: 'A' });

    // Should only see Tenant A's booking
    expect(results).toContainEqual(bookingA);
    expect(results).not.toContainEqual(bookingB);

    // Should not contain Tenant B's description
    expect(results.map((b) => b.description)).not.toContain('Salon B booking');
  });
});
```

---

## Deep Dive 4: Scaling Beyond Shared Schema

### Question

> "At what point do you move away from shared schema?"

### Detailed Answer

**Scale Indicators:**

| Metric              | Shared Schema OK | Start Considering Alternatives |
| ------------------- | ---------------- | ------------------------------ |
| Tenants             | <1000            | >5000                          |
| Data per tenant     | <100GB           | >500GB                         |
| QPS per tenant      | <1000            | >5000                          |
| Monthly growth rate | <20%             | >50%                           |

**Why Shared Schema Gets Hard:**

1. **One tenant dominates** — 1 tenant = 90% of database traffic
2. **Hardware limits** — Single database server can only scale vertically so far
3. **Query patterns diverge** — Tenant A needs complex reporting; Tenant B needs simple API
4. **Compliance** — Some tenants need dedicated infrastructure

**Scaling Strategies:**

**Strategy 1: Read Replicas (Easiest)**

```
Primary DB (writes) → Replica 1 (reads) → Replica 2 (reads)
                    → Replica 3 (reads) → Replica 4 (reads)

Read queries go to nearest replica
Write queries go to primary (small latency penalty)
Works for: 80% read heavy workloads
```

**Strategy 2: Dedicated Read Replicas for Large Tenants**

```
Large Tenant → Dedicated Replica
Medium Tenants → Shared Replica
Small Tenants → Primary + Shared Replica

Routing logic: Look up tenant size, route to appropriate replica
```

**Strategy 3: Tenant-Specific Sharding**

```
Database 1: Tenants A-H
Database 2: Tenants I-P
Database 3: Tenants Q-Z

Routing: Hash tenant_id to determine shard
Migration: Move tenant from shared to dedicated shard
Trade-off: Can't query across shards (no cross-tenant reports)
```

**Strategy 4: Dedicated Database for Massive Tenants**

```
Tenant A (massive) → Dedicated Database (fully isolated)
Other Tenants → Shared Database

Monitoring: Detects when tenant exceeds threshold, auto-migrates

Example: "Once Tenant A > 1TB data, create dedicated instance"
```

**Migration Path:**

```
Phase 1: Tenant still in shared database
Phase 2: Create dedicated database, start replication
Phase 3: Switch writes to dedicated database
Phase 4: Delete from shared database
Phase 5: Monitor for issues

Rollback: Replication is still running, switch back to shared
```

**Code Changes for Sharding:**

```typescript
// Route queries to correct database
function getDb(tenantId: string) {
  const shard = getTenantShard(tenantId);
  return databases[shard]; // Returns correct DB client
}

// Usage
const bookings = await getDb(tenantId)
  .select()
  .from(bookingsTable)
  .where(eq(bookingsTable.tenantId, tenantId));

// Same code, different database!
```

**When to Stay on Shared Schema:**

- Majority of tenants are small
- Cross-tenant features (marketplace, analytics)
- Operational simplicity is more important than raw performance
- Budget constraints

**When to Move Away:**

- Specific large tenants causing problems
- Compliance requirements (must isolate)
- Different data retention policies per tenant
- Need for complete schema customization per tenant

---

## Deep Dive 5: Monitoring Multi-Tenant Systems

### Question

> "How do you monitor a multi-tenant system to catch tenant-specific issues?"

### Detailed Answer

**Metric Collection with Tenant Context:**

```typescript
import { Counter, Histogram } from 'prom-client';

// Track metrics per tenant
const apiRequestCounter = new Counter({
  name: 'api_requests_total',
  help: 'Total API requests',
  labelNames: ['method', 'route', 'tenant_id', 'status'],
});

const queryDurationHistogram = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration',
  labelNames: ['query_type', 'tenant_id'],
});

// Record metrics with tenant context
app.use((req, res, next) => {
  const tenantId = req.user?.tenantId || 'anonymous';

  res.on('finish', () => {
    apiRequestCounter
      .labels(req.method, req.route.path, tenantId, res.statusCode)
      .inc();
  });

  next();
});

// Track query time
async function executeQuery(query, tenantId) {
  const timer = queryDurationHistogram.startTimer({
    query_type: query.type,
    tenant_id: tenantId,
  });

  try {
    return await query.execute();
  } finally {
    timer();
  }
}
```

**Alerting on Tenant-Specific Issues:**

```yaml
# Prometheus alert rules
groups:
  - name: multi-tenant
    rules:
      # Alert if a tenant has high error rate
      - alert: TenantHighErrorRate
        expr: |
          (
            rate(api_requests_total{status=~"5.."}[5m])
            /
            rate(api_requests_total[5m])
          ) > 0.05
        labels:
          severity: critical
        annotations:
          summary: 'Tenant {{ $labels.tenant_id }} has high error rate'

      # Alert if a tenant is slow
      - alert: TenantSlowQueries
        expr: |
          histogram_quantile(
            0.95,
            db_query_duration_seconds_bucket{tenant_id="{{ tenant_id }}"}
          ) > 1
        labels:
          severity: warning
        annotations:
          summary: 'Tenant {{ $labels.tenant_id }} has slow queries (p95 > 1s)'
```

**Dashboard Queries:**

```promql
# Average latency per tenant
rate(http_request_duration_seconds_sum[5m])
  / rate(http_request_duration_seconds_count[5m])
  by (tenant_id)

# Request volume per tenant
rate(api_requests_total[5m])
  by (tenant_id)

# Error rate per tenant
rate(api_requests_total{status=~"5.."}[5m])
  / rate(api_requests_total[5m])
  by (tenant_id)

# Database connections per tenant
pg_stat_activity_count
  by (tenant_id)
```

**Structured Logging with Tenant Context:**

```typescript
import winston from 'winston';

const logger = winston.createLogger({
  format: winston.format.json(),
  defaultMeta: { service: 'api' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// Log with tenant context
logger.info('Created booking', {
  tenantId: 'A',
  bookingId: '123',
  customerId: 'cust-456',
  action: 'create_booking',
});

// Query logs for tenant: ELK or Splunk
// Filter: tenant_id = 'A'
```

---

## Deep Dive 6: Security Audit Checklist

### Question

> "How would you audit your system for tenant isolation vulnerabilities?"

### Checklist

**Code Review Checklist:**

- [ ] Every SELECT includes `WHERE tenant_id = ?`
- [ ] Every INSERT includes `tenant_id` explicit SET
- [ ] Every UPDATE includes `tenant_id` in WHERE
- [ ] Every DELETE includes `tenant_id` in WHERE
- [ ] JOIN conditions include tenant_id filter
- [ ] Foreign keys are composite `(tenant_id, id)`
- [ ] Soft deletes include `deleted_at IS NULL` filter
- [ ] Cache keys include tenant_id
- [ ] Logging doesn't expose other tenant data
- [ ] `tenant_id` comes from JWT, never from request body

**Testing Checklist:**

- [ ] Integration tests with 2+ tenants
- [ ] Verify Tenant A cannot see Tenant B data
- [ ] Verify soft-deleted data is hidden
- [ ] Test permission enforcement per tenant
- [ ] Test cache doesn't leak across tenants
- [ ] Test cross-tenant relationship rejection
- [ ] Fuzz test with random tenant_ids

**Runtime Checklist:**

- [ ] Query logs show `WHERE tenant_id = ?` in every query
- [ ] No queries return data from multiple tenants
- [ ] Cache hit rate is consistent (no anomalies)
- [ ] Error logs don't expose other tenant information
- [ ] Audit logs track who accessed what

---

## Deep Dive 7: What Would You Do Differently?

### Question

> "If you rebuilt this system today, what would you change?"

### Honest Reflection

**What Worked:**

✅ Row-level filtering at database level — caught bugs early
✅ TypeScript strict mode — saved debugging time
✅ Composite keys — prevented cross-tenant references
✅ Audit logging — made debugging forensic instead of guesswork

**What I'd Change:**

1. **Feature Flags from Day One**

   > "We added them mid-project. From day one, I'd gate all features behind feature flags. Makes testing easier and rollout safer."

2. **Monitoring from Day One**

   > "We added observability later. I'd start with metrics, traces, and structured logging on day 1. Finding bugs is 10x easier with good logs."

3. **Tenant-Aware Testing Framework**

   > "I'd build test utilities that create multi-tenant test contexts. Make it trivial to test isolation: `test.multi({ tenant_a, tenant_b }, ...). Right now it's boilerplate in every test."

4. **Database-Level Permissions**

   > "I'd use PostgreSQL roles per tenant. Not just application-level RBAC, but database-level row security policies (RLS). Defense in depth from day one."

5. **Automated Data Leak Detection**
   > "Run periodic checks: 'Find any row where tenant_id != expected'. Simple query, huge value. We do this monthly but I'd automate and alert."

---

## Deep Dive 8: Future Scaling Questions

### Question

> "How would you scale to 1 million tenants?"

### Detailed Answer

**Capacity Planning:**

```
1 million tenants with average 1GB per tenant = 1 petabyte
Shared database can't handle this.

Solution: Tiered architecture
- Small tenants (<1GB): Shared database (99% of tenants)
- Medium tenants (1-100GB): Dedicated database
- Large tenants (>100GB): Dedicated cluster

Monitoring: Alert when tenant exceeds tier threshold, auto-migrate
```

**Architecture:**

```
Load Balancer
  ↓
Service Layer (stateless)
  ├─ Tenant Routing Service (routes to correct DB)
  ├─ Auth Service
  ├─ Business Logic Service
  ↓
Database Router
  ├─ Shared Database (small tenants)
  ├─ Tier 1 Databases (medium tenants)
  └─ Tier 2 Clusters (large tenants)
```

**Implementation:**

```typescript
// Tenant sharding logic
async function getTenantDb(tenantId: string) {
  const tenant = await getTenantMetadata(tenantId);

  switch (tenant.tier) {
    case 'SMALL':
      return sharedDb;
    case 'MEDIUM':
      return dedicatedDbs[tenant.dbShard];
    case 'LARGE':
      return largeTenantClusters[tenant.clusterId];
  }
}

// Usage (same code, different database)
const db = await getTenantDb(tenantId);
const bookings = await db.select()...
```

---

## Last Word

**The real skill** in multi-tenant systems isn't one decision. It's:

- Thinking about isolation in every query
- Testing with multiple tenants
- Monitoring for anomalies
- Changing your mind when requirements change

If you can explain your reasoning and defend your trade-offs, you're ready.

---

**Last updated:** 2025-01-15
Good luck!
