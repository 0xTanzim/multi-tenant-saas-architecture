# Tenant-Scoped Queries: Patterns and Optimization

## Table of Contents

1. [Golden Rule](#golden-rule)
2. [Query Pattern: Always Filter by Tenant ID](#query-pattern-always-filter-by-tenant-id)
3. [Prevention of N+1 Queries](#prevention-of-n1-queries)
4. [Eager Loading Relationships](#eager-loading-relationships)
5. [Query Optimization Techniques](#query-optimization-techniques)
6. [SQL Examples](#sql-examples)
7. [ORM Patterns (Drizzle)](#orm-patterns-drizzle)

---

## Golden Rule

> **Every query must filter by `tenant_id`. This is not optional.**

Violation of this rule = **Data leak**. A query that returns data from multiple tenants is a critical security bug.

---

## Query Pattern: Always Filter by Tenant ID

### The Pattern

Every query follows this structure:

```sql
SELECT *
FROM table_name
WHERE tenant_id = ?
  AND [other business filters]
  AND deleted_at IS NULL;
```

### Wrong vs. Right Examples

#### ❌ WRONG: Missing Tenant Filter

```sql
-- BUG: Returns bookings for ALL tenants
SELECT * FROM bookings
WHERE status = 'completed';

-- BUG: Returns staff for ALL tenants
SELECT * FROM staff_employments
WHERE position = 'Stylist';
```

#### ✅ RIGHT: Tenant Filter Always Present

```sql
-- CORRECT: Returns bookings for one tenant only
SELECT * FROM bookings
WHERE tenant_id = 1
  AND status = 'completed'
  AND deleted_at IS NULL;

-- CORRECT: Returns staff for one tenant only
SELECT * FROM staff_employments
WHERE tenant_id = 1
  AND position = 'Stylist'
  AND deleted_at IS NULL;
```

### Implementation: How to Get tenant_id

**1. From Authenticated User Context**:

```typescript
// Node.js + Express
app.get('/bookings', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const tenantId = req.user.tenant_id; // Set by auth middleware

  // Query always includes tenantId
  const bookings = await getBookingsByTenant(tenantId);
  res.json(bookings);
});
```

**2. From JWT Token**:

```typescript
// Auth middleware extracts tenant_id from token
const token = req.headers.authorization?.split(' ')[1];
const decoded = jwt.verify(token, SECRET);
const tenantId = decoded.tenant_id;

// Pass to all queries
const data = await query(tenantId, ...);
```

**3. Via Request Parameters**:

```typescript
// For API routes with tenant_id in the path
app.get('/api/tenants/:tenantId/bookings', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId);

  // Verify user has access to this tenant (authorization check)
  const userTenants = await getUserTenants(req.user.id);
  if (!userTenants.includes(tenantId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Query always filtered by tenantId
  const bookings = await getBookings(tenantId);
  res.json(bookings);
});
```

---

## Prevention of N+1 Queries

### The Problem: N+1 Query Anti-Pattern

**Scenario**: Fetch 100 bookings and for each, fetch the customer details.

#### ❌ NAIVE (N+1 Queries):

```typescript
// Query 1: Fetch bookings
const bookings = await db
  .select()
  .from(bookings)
  .where(eq(bookings.tenant_id, tenantId));
// Result: 100 bookings in 1 query ✓

// Query 2-101: Fetch customer for each booking
for (const booking of bookings) {
  const customer = await db
    .select()
    .from(customers)
    .where(eq(customers.id, booking.customer_id))
    .andWhere(eq(customers.tenant_id, tenantId));
  booking.customer = customer;
}
// Result: 100 additional queries ✗ SLOW

// Total: 1 + 100 = 101 queries
```

**Impact**: 101 round trips to the database. Extremely slow.

#### ✅ CORRECT (Join):

```sql
SELECT
  b.id, b.booking_date, b.status,
  c.id, c.name, c.email, c.phone
FROM bookings b
JOIN customers c ON b.customer_id = c.id
WHERE b.tenant_id = 1
  AND b.deleted_at IS NULL
  AND c.deleted_at IS NULL;
```

**Result**: 1 query, all data fetched. Much faster.

### Real-World Impact

| Approach    | Queries | Time       | Scaling          |
| ----------- | ------- | ---------- | ---------------- |
| N+1 (naive) | 101     | ~5 seconds | O(n) — terrible  |
| Join        | 1       | ~50ms      | O(1) — excellent |

**Golden Rule**: Never loop through results and query for each item. Use JOINs instead.

---

## Eager Loading Relationships

### Pattern: Use JOINs to Load Related Data

### Example 1: Booking with Customer and Staff

**SQL**:

```sql
SELECT
  b.id,
  b.booking_date,
  b.status,
  b.total_amount,

  -- Customer data
  c.id AS customer_id,
  c.name AS customer_name,
  c.email AS customer_email,
  c.phone AS customer_phone,

  -- Staff data
  se.id AS staff_id,
  se.position,
  se.employee_id,

  -- Service data
  s.id AS service_id,
  s.name AS service_name,
  s.duration_minutes
FROM bookings b
JOIN customers c ON b.customer_id = c.id
JOIN staff_employments se ON b.primary_staff_employment_id = se.id
LEFT JOIN services s ON b.service_id = s.id
WHERE b.tenant_id = 1
  AND b.deleted_at IS NULL
  AND c.deleted_at IS NULL
  AND se.deleted_at IS NULL;
```

**Drizzle ORM**:

```typescript
import { eq, isNull, and } from 'drizzle-orm';

const bookingDetails = await db
  .select({
    // Booking columns
    id: bookings.id,
    booking_date: bookings.booking_date,
    status: bookings.status,
    total_amount: bookings.total_amount,

    // Customer columns (nested in result)
    customer: {
      id: customers.id,
      name: customers.name,
      email: customers.email,
      phone: customers.phone,
    },

    // Staff columns
    staff: {
      id: staff_employments.id,
      position: staff_employments.position,
      employee_id: staff_employments.employee_id,
    },

    // Service columns
    service: {
      id: services.id,
      name: services.name,
      duration_minutes: services.duration_minutes,
    },
  })
  .from(bookings)
  .innerJoin(customers, eq(bookings.customer_id, customers.id))
  .innerJoin(
    staff_employments,
    eq(bookings.primary_staff_employment_id, staff_employments.id)
  )
  .leftJoin(services, eq(bookings.service_id, services.id))
  .where(
    and(
      eq(bookings.tenant_id, tenantId),
      isNull(bookings.deleted_at),
      isNull(customers.deleted_at),
      isNull(staff_employments.deleted_at)
    )
  );
```

### Example 2: Staff Schedule with Blocked Times

**SQL**:

```sql
SELECT
  se.id,
  se.position,
  se.status,

  -- Aggregated booking count
  COUNT(b.id) AS total_bookings,

  -- Time off entries
  (SELECT json_agg(json_build_object(
    'id', to_id,
    'start_date', start_date,
    'end_date', end_date,
    'reason', reason
  ))
  FROM time_off
  WHERE staff_employment_id = se.id
    AND tenant_id = 1
    AND deleted_at IS NULL
    AND start_date >= CURRENT_DATE
  ) AS upcoming_time_off
FROM staff_employments se
LEFT JOIN bookings b ON b.primary_staff_employment_id = se.id
  AND b.tenant_id = 1
  AND b.deleted_at IS NULL
  AND b.booking_date >= CURRENT_DATE
WHERE se.tenant_id = 1
  AND se.status = 'active'
  AND se.deleted_at IS NULL
GROUP BY se.id;
```

---

## Query Optimization Techniques

### 1. Use Indexes Effectively

**Query**: "Get bookings for a specific customer on a date"

```sql
-- Create optimal index
CREATE INDEX idx_bookings_customer_date
  ON bookings(tenant_id, customer_id, booking_date)
  WHERE deleted_at IS NULL;

-- Query that uses the index
SELECT * FROM bookings
WHERE tenant_id = 1
  AND customer_id = 42
  AND booking_date = '2026-05-10'
  AND deleted_at IS NULL;
```

**Why**: The index matches the WHERE clause perfectly. PostgreSQL can scan the index without touching the main table.

### 2. Composite Filters

**Query**: "Get all active bookings for a tenant with a specific status"

```sql
-- Index
CREATE INDEX idx_bookings_tenant_status_date
  ON bookings(tenant_id, status, booking_date DESC)
  WHERE deleted_at IS NULL;

-- Query
SELECT id, booking_date, customer_id, total_amount
FROM bookings
WHERE tenant_id = 1
  AND status = 'confirmed'
  AND booking_date >= '2026-05-01'
  AND deleted_at IS NULL
ORDER BY booking_date DESC;
```

### 3. EXPLAIN PLAN to Verify Index Usage

Always check that queries use indexes:

```sql
EXPLAIN ANALYZE
SELECT * FROM bookings
WHERE tenant_id = 1
  AND customer_id = 42
  AND booking_date = '2026-05-10'
  AND deleted_at IS NULL;
```

**Expected output**:

```
Index Scan using idx_bookings_customer_date on bookings
  (cost=0.29..8.30 rows=1)
  Index Cond: (tenant_id = 1) AND (customer_id = 42)
    AND (booking_date = '2026-05-10')
  Filter: (deleted_at IS NULL)
```

**If you see "Seq Scan"**: The index isn't being used. Check the index definition.

### 4. Pagination for Large Result Sets

**Problem**: Fetching 1 million bookings at once crashes the application.

**Solution**: Paginate with LIMIT and OFFSET

```sql
-- Page 1 (rows 1-50)
SELECT * FROM bookings
WHERE tenant_id = 1 AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 50 OFFSET 0;

-- Page 2 (rows 51-100)
SELECT * FROM bookings
WHERE tenant_id = 1 AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 50 OFFSET 50;

-- Page N (cursor-based is faster for large offsets)
SELECT * FROM bookings
WHERE tenant_id = 1
  AND deleted_at IS NULL
  AND created_at < '2026-05-10 12:00:00'
ORDER BY created_at DESC
LIMIT 50;
```

**Cursor-Based Pagination** (preferred):

- Use timestamp or ID as cursor
- Faster than OFFSET for large pages
- Handles data changes between pages correctly

### 5. Materialized Views for Complex Aggregations

**Problem**: Complex analytics query runs slow every time.

**Solution**: Materialized view computed once, queried many times

```sql
-- Create materialized view
CREATE MATERIALIZED VIEW booking_analytics_by_staff AS
SELECT
  se.id AS staff_id,
  se.position,
  COUNT(*) AS total_bookings,
  COUNT(CASE WHEN b.status = 'completed' THEN 1 END) AS completed,
  COUNT(CASE WHEN b.is_no_show THEN 1 END) AS no_shows,
  AVG(b.total_amount)::DECIMAL(10, 2) AS avg_booking_value,
  MAX(b.booking_date) AS last_booking_date
FROM staff_employments se
LEFT JOIN bookings b ON b.primary_staff_employment_id = se.id
  AND b.tenant_id = se.tenant_id
  AND b.deleted_at IS NULL
WHERE se.deleted_at IS NULL
GROUP BY se.id, se.position;

-- Index the materialized view for fast queries
CREATE INDEX idx_booking_analytics_staff_id
  ON booking_analytics_by_staff(staff_id);

-- Query (very fast)
SELECT * FROM booking_analytics_by_staff
WHERE staff_id = 123;

-- Refresh when data changes
REFRESH MATERIALIZED VIEW booking_analytics_by_staff;
```

---

## SQL Examples

### Common Query Patterns

#### 1. Fetch Bookings for a Date Range with Customer Info

```sql
SELECT
  b.id,
  b.booking_date,
  b.start_time,
  b.end_time,
  b.status,
  c.name AS customer_name,
  c.email,
  c.phone,
  se.position,
  u.name AS staff_name,
  b.total_amount
FROM bookings b
JOIN customers c ON b.customer_id = c.id
JOIN staff_employments se ON b.primary_staff_employment_id = se.id
JOIN users u ON se.hired_by = u.id
WHERE b.tenant_id = 1
  AND b.booking_date BETWEEN '2026-05-01' AND '2026-05-31'
  AND b.deleted_at IS NULL
  AND c.deleted_at IS NULL
  AND se.deleted_at IS NULL
ORDER BY b.booking_date, b.start_time;
```

#### 2. Count No-Shows by Staff Member

```sql
SELECT
  se.employee_id,
  u.name AS staff_name,
  COUNT(*) AS total_bookings,
  COUNT(CASE WHEN b.is_no_show THEN 1 END) AS no_shows,
  ROUND(
    100.0 * COUNT(CASE WHEN b.is_no_show THEN 1 END) / COUNT(*),
    2
  ) AS no_show_percentage
FROM staff_employments se
LEFT JOIN bookings b ON b.primary_staff_employment_id = se.id
  AND b.tenant_id = se.tenant_id
  AND b.deleted_at IS NULL
LEFT JOIN users u ON se.hired_by = u.id
WHERE se.tenant_id = 1
  AND se.deleted_at IS NULL
  AND b.booking_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY se.id, se.employee_id, u.name
ORDER BY no_show_percentage DESC;
```

#### 3. Revenue by Service

```sql
SELECT
  s.id,
  s.name,
  COUNT(*) AS bookings_completed,
  SUM(b.total_amount)::DECIMAL(10, 2) AS total_revenue,
  AVG(b.total_amount)::DECIMAL(10, 2) AS avg_booking_value
FROM services s
LEFT JOIN bookings b ON b.service_id = s.id
  AND b.tenant_id = s.tenant_id
  AND b.status = 'completed'
  AND b.deleted_at IS NULL
WHERE s.tenant_id = 1
  AND s.deleted_at IS NULL
GROUP BY s.id, s.name
ORDER BY total_revenue DESC;
```

#### 4. Staff Availability Analysis

```sql
SELECT
  se.id,
  se.employee_id,
  u.name,
  se.status,
  COUNT(b.id) AS bookings_this_month,
  se.max_bookings_per_day,
  (SELECT COUNT(*) FROM time_off
   WHERE staff_employment_id = se.id
     AND tenant_id = 1
     AND deleted_at IS NULL
     AND start_date <= CURRENT_DATE + INTERVAL '30 days'
  ) AS scheduled_time_off_days
FROM staff_employments se
LEFT JOIN users u ON se.hired_by = u.id
LEFT JOIN bookings b ON b.primary_staff_employment_id = se.id
  AND b.tenant_id = se.tenant_id
  AND b.booking_date >= DATE_TRUNC('month', CURRENT_DATE)
  AND b.deleted_at IS NULL
WHERE se.tenant_id = 1
  AND se.deleted_at IS NULL
  AND se.status IN ('hired', 'active')
GROUP BY se.id, u.name
ORDER BY bookings_this_month DESC;
```

---

## ORM Patterns (Drizzle)

### Setup

```typescript
import { eq, isNull, and, gte, lte, desc } from 'drizzle-orm';
import { db } from './database'; // Drizzle client

// Tables
import {
  bookings,
  customers,
  staff_employments,
  services,
  users,
} from '@/db/schema';
```

### Pattern 1: Simple Tenant-Scoped Query

```typescript
async function getBookingsByTenant(tenantId: number) {
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenant_id, tenantId), isNull(bookings.deleted_at)))
    .orderBy(desc(bookings.created_at));
}
```

### Pattern 2: Query with JOIN

```typescript
async function getBookingsWithCustomerInfo(tenantId: number, status: string) {
  return db
    .select({
      id: bookings.id,
      booking_date: bookings.booking_date,
      start_time: bookings.start_time,
      end_time: bookings.end_time,
      status: bookings.status,
      total_amount: bookings.total_amount,

      customer_name: customers.name,
      customer_email: customers.email,
      customer_phone: customers.phone,
    })
    .from(bookings)
    .innerJoin(customers, eq(bookings.customer_id, customers.id))
    .where(
      and(
        eq(bookings.tenant_id, tenantId),
        eq(bookings.status, status),
        isNull(bookings.deleted_at),
        isNull(customers.deleted_at)
      )
    )
    .orderBy(desc(bookings.booking_date));
}
```

### Pattern 3: Filtered with Pagination

```typescript
async function getBookingsPaginated(
  tenantId: number,
  limit: number = 50,
  offset: number = 0
) {
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenant_id, tenantId), isNull(bookings.deleted_at)))
    .orderBy(desc(bookings.created_at))
    .limit(limit)
    .offset(offset);
}
```

### Pattern 4: Aggregate Queries

```typescript
async function getBookingStatsByStaff(tenantId: number) {
  const stats = await db
    .select({
      staff_id: staff_employments.id,
      staff_name: users.name,
      total_bookings: sql`COUNT(*)`,
      completed_bookings: sql`COUNT(CASE WHEN ${eq(
        bookings.status,
        'completed'
      )} THEN 1 END)`,
      avg_value: sql`AVG(${bookings.total_amount})`,
    })
    .from(staff_employments)
    .leftJoin(
      bookings,
      and(
        eq(bookings.primary_staff_employment_id, staff_employments.id),
        eq(bookings.tenant_id, tenantId),
        isNull(bookings.deleted_at)
      )
    )
    .leftJoin(users, eq(staff_employments.hired_by, users.id))
    .where(
      and(
        eq(staff_employments.tenant_id, tenantId),
        isNull(staff_employments.deleted_at)
      )
    )
    .groupBy(staff_employments.id, users.name);

  return stats;
}
```

---

## Summary

**Key Takeaways**:

1. **Every query must filter by `tenant_id`** — No exceptions
2. **Use JOINs instead of N+1 loops** — Massively faster
3. **Create composite indexes with `tenant_id` first** — Enables optimization
4. **Use `WHERE deleted_at IS NULL`** — Respects soft deletes
5. **Profile slow queries with `EXPLAIN ANALYZE`** — Verify index usage
6. **Paginate large result sets** — Prevent memory exhaustion

---

## Next Steps

- Review [Soft Delete Strategy](./SOFT_DELETE_STRATEGY.md) for handling logical deletes
- Check [Migration Strategy](./MIGRATION_STRATEGY.md) for schema evolution
- See code examples: [SQL Examples](./code-examples/sql/)
