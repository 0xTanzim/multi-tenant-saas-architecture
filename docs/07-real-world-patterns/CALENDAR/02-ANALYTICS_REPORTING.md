# Case Study: Multi-Tenant Analytics & Reporting

**Context:** SaaS platform providing analytics dashboards to multiple tenants, each seeing only their own data

**Complexity:** Aggregation without leakage, privacy-preserving metrics, time-series queries, performance under load

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Privacy Requirements](#privacy-requirements)
3. [Data Model for Analytics](#data-model-for-analytics)
4. [Aggregation Queries](#aggregation-queries)
5. [Time-Series Analytics](#time-series-analytics)
6. [Dashboard Access Control](#dashboard-access-control)
7. [Performance Optimization](#performance-optimization)
8. [Common Pitfalls](#common-pitfalls)

---

## Problem Statement

A multi-tenant SaaS platform collects operational data from all tenants. Each tenant needs:

- **Custom dashboards** showing their metrics only
- **Historical trends** (last 30 days, 90 days, year-over-year)
- **Comparative metrics** (anonymized peer benchmarks)
- **Export capabilities** (CSV/PDF of their data only)

**Constraints:**

- Tenant A must never see Tenant B's data, even aggregated
- "Benchmarking reports" must be anonymous
- Performance must remain constant as data grows
- Data warehouse queries should not lock operational tables

### Interview Problem

> "Design an analytics system where 10k tenants can run custom reports simultaneously without seeing each other's data. How do you prevent data leakage? How do you make time-series queries fast?"

---

## Privacy Requirements

### Principle: Query-Level Data Isolation

```typescript
// ✗ WRONG: Tenant A could hack this to see Tenant B's data
const query = `SELECT * FROM analytics WHERE date >= ?`;
// If an attacker modifies the query, they might remove the tenant_id filter

// ✓ CORRECT: Tenant_id is enforced in application layer
async function getDashboardMetrics(tenantId: string, dateRange: DateRange) {
  return db.query(
    `
    SELECT * FROM analytics_fact
    WHERE tenant_id = $1  -- ← MANDATORY, enforced in app logic
      AND date >= $2
      AND date <= $3
  `,
    [tenantId, dateRange.start, dateRange.end]
  );
}
```

### Anonymization Strategy

**Problem:** "Show me how my metrics compare to peers" without revealing peer identities.

```sql
-- ✓ CORRECT: Aggregate without exposing individual tenants
SELECT
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY revenue) as median_revenue,
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY revenue) as q1_revenue,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY revenue) as q3_revenue,
  COUNT(*) as peer_count
FROM analytics_summary
WHERE industry = 'salon'
  AND revenue_range = 'mid_market'  -- Only compare to similar-sized tenants
  AND date = CURRENT_DATE;
```

**Never expose:**

```sql
-- ✗ WRONG: Identifies peers
SELECT tenant_id, revenue FROM analytics_summary ORDER BY revenue DESC;

-- ✗ WRONG: Too granular
SELECT tenant_name, revenue, booking_count FROM analytics_summary;

-- ✓ CORRECT: Anonymous aggregates only
SELECT COUNT(*), AVG(revenue), MAX(revenue) FROM analytics_summary;
```

### Access Control Tiers

| Role                   | Can See                               | Can Export                |
| ---------------------- | ------------------------------------- | ------------------------- |
| Tenant Owner           | All their data                        | Their data only           |
| Tenant Staff (Manager) | High-level summaries                  | Their team's metrics      |
| Tenant Staff (Basic)   | Read-only dashboard                   | None                      |
| Platform Admin         | All aggregates, anonymized            | None (privacy protection) |
| Finance Team           | Revenue data + anonymized comparisons | Aggregated reports        |

```typescript
interface AnalyticsAccess {
  tenantId: string;
  role: 'owner' | 'manager' | 'staff' | 'admin';
  canViewDetailedMetrics: boolean;
  canExportData: boolean;
  canSeeOtherTenants: boolean; // Always false except admin
  dataGranularity: 'detailed' | 'summary' | 'anonymous';
}

async function getMetrics(access: AnalyticsAccess, query: MetricsQuery) {
  if (access.canSeeOtherTenants) {
    // Platform admin: return anonymized aggregates only
    return getAnonAggregates(query);
  } else if (access.role === 'owner') {
    // Tenant owner: return all details
    return getDetailedMetrics(access.tenantId, query);
  } else if (access.role === 'manager') {
    // Manager: return filtered summary (only their team)
    return getSummaryMetrics(access.tenantId, query);
  } else {
    throw new ForbiddenError('Insufficient access');
  }
}
```

---

## Data Model for Analytics

### Events Table (Fact Table)

```sql
CREATE TABLE analytics_events (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  event_type VARCHAR NOT NULL, -- 'booking_created', 'payment_processed', 'staff_assigned'

  -- Denormalized for fast queries
  event_date DATE NOT NULL,
  event_hour SMALLINT, -- 0-23

  -- Event-specific data (sparse columns or JSONB)
  event_data JSONB, -- {'staff_id': 123, 'service_id': 456, 'duration_minutes': 30}

  -- Aggregated values (pre-calculated for fast reporting)
  metric_value NUMERIC,
  metric_unit VARCHAR, -- 'minutes', 'cents', 'count'

  created_at TIMESTAMP DEFAULT NOW(),

  INDEX (tenant_id, event_date, event_type),
  INDEX (tenant_id, event_date)
);
```

### Summary Table (Pre-aggregated)

```sql
CREATE TABLE analytics_daily_summary (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  summary_date DATE NOT NULL,

  -- Pre-aggregated metrics
  total_bookings INTEGER,
  completed_bookings INTEGER,
  cancelled_bookings INTEGER,
  total_revenue_cents BIGINT,
  average_booking_value_cents BIGINT,

  -- Capacity metrics
  total_staff_hours INTEGER,
  utilized_staff_hours INTEGER,

  -- Customer metrics
  new_customers INTEGER,
  returning_customers INTEGER,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (tenant_id, summary_date),
  INDEX (tenant_id, summary_date DESC)
);
```

### Key Design Decisions

**Denormalization for Speed:**

```sql
-- Instead of JOIN-ing multiple tables for each query
-- Denormalize into the events table
analytics_events:
  tenant_id     -- ✓
  event_date    -- ✓ (pre-computed, not extracted)
  staff_id      -- ✓ (denormalized from booking)
  service_id    -- ✓ (denormalized from booking)
  revenue_cents -- ✓ (denormalized from payment)
```

**Pre-aggregation:**

```sql
-- Instead of computing SUM on-the-fly
-- Pre-compute daily summaries at end-of-day

-- During the day: write individual events to analytics_events
INSERT INTO analytics_events (tenant_id, event_type, event_date, metric_value)
VALUES (123, 'booking_created', '2025-05-10', 1);

-- At end-of-day: batch compute summary
INSERT INTO analytics_daily_summary (tenant_id, summary_date, total_bookings)
SELECT tenant_id, event_date, COUNT(*)
FROM analytics_events
WHERE event_date = CURRENT_DATE - 1
  AND event_type = 'booking_created'
GROUP BY tenant_id, event_date;
```

---

## Aggregation Queries

### Pattern 1: Daily Active Metrics

```sql
-- Get daily bookings for last 30 days
SELECT
  summary_date,
  total_bookings,
  completed_bookings,
  total_revenue_cents / 100.0 as total_revenue
FROM analytics_daily_summary
WHERE tenant_id = $1
  AND summary_date >= CURRENT_DATE - 30
ORDER BY summary_date DESC;
```

### Pattern 2: Period-Over-Period Comparison

```sql
-- Compare this month vs. last month
WITH current_month AS (
  SELECT
    SUM(total_bookings) as bookings,
    SUM(total_revenue_cents) as revenue
  FROM analytics_daily_summary
  WHERE tenant_id = $1
    AND summary_date >= DATE_TRUNC('month', CURRENT_DATE)
    AND summary_date < CURRENT_DATE + 1
),
previous_month AS (
  SELECT
    SUM(total_bookings) as bookings,
    SUM(total_revenue_cents) as revenue
  FROM analytics_daily_summary
  WHERE tenant_id = $1
    AND summary_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
    AND summary_date < DATE_TRUNC('month', CURRENT_DATE)
)
SELECT
  c.bookings as current_bookings,
  p.bookings as previous_bookings,
  ROUND(((c.bookings::NUMERIC - p.bookings) / p.bookings) * 100, 2) as pct_change
FROM current_month c, previous_month p;
```

### Pattern 3: Top Performers (with Privacy)

```sql
-- Top 5 staff by revenue (tenant can see their own staff only)
SELECT
  staff_id,
  SUM(total_revenue_cents) as revenue
FROM analytics_events
WHERE tenant_id = $1
  AND event_type = 'payment_processed'
  AND event_date >= CURRENT_DATE - 30
GROUP BY staff_id
ORDER BY revenue DESC
LIMIT 5;
```

### Pattern 4: Cohort Analysis

```sql
-- Track customer behavior by signup month (tenant-scoped)
WITH customer_cohorts AS (
  SELECT
    DATE_TRUNC('month', created_at)::DATE as cohort_month,
    customer_id
  FROM customers
  WHERE tenant_id = $1
)
SELECT
  cohort_month,
  COUNT(DISTINCT c.customer_id) as cohort_size,
  COUNT(DISTINCT b.customer_id) as returning_customers,
  ROUND(COUNT(DISTINCT b.customer_id)::NUMERIC / COUNT(DISTINCT c.customer_id) * 100, 2) as retention_pct
FROM customer_cohorts c
LEFT JOIN bookings b ON c.customer_id = b.customer_id
  AND b.created_at >= DATE_TRUNC('month', c.created_at) + INTERVAL '1 month'
  AND b.created_at < DATE_TRUNC('month', c.created_at) + INTERVAL '2 months'
GROUP BY cohort_month
ORDER BY cohort_month;
```

---

## Time-Series Analytics

### Challenge: Storing Historical Data

As data grows, queries become slow. Solution: Time-series partitioning.

```sql
-- Partition by month to keep indexes small
CREATE TABLE analytics_daily_summary_2025_01 PARTITION OF analytics_daily_summary
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE analytics_daily_summary_2025_02 PARTITION OF analytics_daily_summary
  FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');

-- Query is automatically routed to correct partition
SELECT * FROM analytics_daily_summary
WHERE tenant_id = 123 AND summary_date = '2025-02-15';
-- (Queries only the 2025_02 partition, ignoring 2025_01, 2025_03, etc.)
```

### Retention Policy

```sql
-- Archive old data after 2 years
DELETE FROM analytics_daily_summary
WHERE summary_date < CURRENT_DATE - INTERVAL '2 years';

-- For audit/compliance, move to cold storage (S3, not active DB)
INSERT INTO s3_archive.analytics_2023_01
SELECT * FROM analytics_daily_summary
WHERE EXTRACT(YEAR FROM summary_date) = 2023
  AND EXTRACT(MONTH FROM summary_date) = 1;

DELETE FROM analytics_daily_summary
WHERE EXTRACT(YEAR FROM summary_date) = 2023
  AND EXTRACT(MONTH FROM summary_date) = 1;
```

---

## Dashboard Access Control

### Backend: Role-Based Query Filters

```typescript
interface DashboardRequest {
  tenantId: string;
  userRole: 'owner' | 'manager' | 'staff';
  userId: string;
  dateRange: { start: Date; end: Date };
}

async function getDashboardData(req: DashboardRequest) {
  let query = `
    SELECT * FROM analytics_daily_summary
    WHERE tenant_id = $1
      AND summary_date >= $2
      AND summary_date <= $3
  `;

  const params = [req.tenantId, req.dateRange.start, req.dateRange.end];

  // Role-based filtering
  if (req.userRole === 'staff') {
    // Staff can only see their own metrics
    query += ` AND staff_id = $${params.length + 1}`;
    params.push(req.userId);
  } else if (req.userRole === 'manager') {
    // Manager can see their team's metrics
    const team = await getManagerTeam(req.tenantId, req.userId);
    query += ` AND staff_id = ANY($${params.length + 1}::int[])`;
    params.push(team.map((t) => t.staff_id));
  }
  // Owner sees everything (no filter)

  return db.query(query, params);
}
```

### Frontend: Conditional Display

```typescript
interface DashboardProps {
  tenantId: string;
  userRole: string;
}

export function Dashboard({ tenantId, userRole }: DashboardProps) {
  if (userRole === 'owner') {
    return (
      <div>
        <RevenueChart />
        <StaffPerformanceTable />
        <CustomerCohortAnalysis />
        <ExportButton /> {/* ← Owner can export */}
      </div>
    );
  } else if (userRole === 'manager') {
    return (
      <div>
        <TeamPerformanceChart />
        <TeamMemberMetrics />
        {/* No export, no revenue details */}
      </div>
    );
  } else {
    return <ReadOnlyMetricsView />;
  }
}
```

---

## Performance Optimization

### Anti-Pattern: Live Aggregation

```sql
-- ✗ SLOW: Sums entire year on-the-fly
SELECT SUM(revenue) FROM bookings WHERE tenant_id = 123 AND YEAR(created_at) = 2024;
```

### Pattern: Pre-Aggregated Summaries

```sql
-- ✓ FAST: Single row lookup
SELECT total_revenue_cents FROM analytics_yearly_summary
WHERE tenant_id = 123 AND year = 2024;
```

### Materialized Views for Complex Queries

```sql
-- Define a complex query as a materialized view
CREATE MATERIALIZED VIEW analytics_retention_cohorts AS
WITH customer_cohorts AS (
  SELECT
    tenant_id,
    DATE_TRUNC('month', created_at)::DATE as cohort_month,
    customer_id
  FROM customers
)
SELECT
  tenant_id,
  cohort_month,
  COUNT(DISTINCT c.customer_id) as cohort_size,
  ROUND(COUNT(DISTINCT b.customer_id)::NUMERIC / COUNT(DISTINCT c.customer_id) * 100, 2) as retention_pct
FROM customer_cohorts c
LEFT JOIN bookings b ON c.customer_id = b.customer_id
  AND b.created_at >= DATE_TRUNC('month', c.created_at) + INTERVAL '1 month'
GROUP BY tenant_id, cohort_month;

-- Refresh nightly
REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_retention_cohorts;

-- Query is now instant
SELECT * FROM analytics_retention_cohorts WHERE tenant_id = 123;
```

### Query Optimization Checklist

| Optimization               | Benefit                        | Trade-off               |
| -------------------------- | ------------------------------ | ----------------------- |
| Partitioning by date       | Scans only relevant partitions | Maintenance overhead    |
| Pre-aggregation            | Instant queries                | Storage cost, staleness |
| Materialized views         | Complex queries fast           | Refresh overhead        |
| Columnar storage (Parquet) | Fast aggregation               | Not transactional       |
| Caching (Redis)            | Sub-second response            | Invalidation complexity |

---

## Common Pitfalls

### Pitfall 1: Tenant Filter Bypass

```typescript
// ✗ VULNERABLE: Tenant_id comes from user input
const tenantId = req.params.tenantId;
const data = await db.query(
  `SELECT * FROM analytics WHERE tenant_id = ${tenantId}`
);

// ✓ SECURE: Tenant_id comes from authenticated user context
const tenantId = req.user.tenantId; // From JWT/session
const data = await db.query(`SELECT * FROM analytics WHERE tenant_id = $1`, [
  tenantId,
]);
```

### Pitfall 2: Incomplete Anonymization

```sql
-- ✗ STILL IDENTIFIABLE: Tenant name reveals identity
SELECT tenant_name, COUNT(*) as booking_count GROUP BY tenant_name;

-- ✓ ANONYMOUS: Remove identifying info
SELECT COUNT(*) as booking_count FROM analytics_daily_summary;
```

### Pitfall 3: Exporting Customer PII

```typescript
// ✗ WRONG: Exports sensitive customer data
async function exportMetrics(tenantId: string) {
  const data = await db.query(
    `
    SELECT c.name, c.email, c.phone, COUNT(*) as bookings
    FROM customers c
    JOIN bookings b ON c.id = b.customer_id
    WHERE tenant_id = $1
    GROUP BY c.id
  `,
    [tenantId]
  );

  return sendCsvDownload(data);
}

// ✓ CORRECT: Exports only aggregates, no PII
async function exportMetrics(tenantId: string) {
  const data = await db.query(
    `
    SELECT summary_date, total_bookings, total_revenue_cents
    FROM analytics_daily_summary
    WHERE tenant_id = $1
    ORDER BY summary_date
  `,
    [tenantId]
  );

  return sendCsvDownload(data);
}
```

### Pitfall 4: Caching Without Invalidation

```typescript
// ✗ STALE: Cache doesn't invalidate when data changes
const cachedMetrics = new Map();
function getMetrics(tenantId) {
  if (cachedMetrics.has(tenantId)) return cachedMetrics.get(tenantId);
  const metrics = expensiveQuery(tenantId);
  cachedMetrics.set(tenantId, metrics);
  return metrics;
  // But what if a new booking is added? Cache is now stale!
}

// ✓ CORRECT: Invalidate on data change
async function createBooking(booking) {
  await saveBooking(booking);
  cacheManager.invalidate(`metrics:${booking.tenant_id}`); // Clear cache
}

function getMetrics(tenantId) {
  const cached = cacheManager.get(`metrics:${tenantId}`);
  if (cached) return cached;
  const metrics = expensiveQuery(tenantId);
  cacheManager.set(`metrics:${tenantId}`, metrics, ttl: 300); // 5 min TTL
  return metrics;
}
```

---

## Summary

**Multi-Tenant Analytics Checklist:**

- [x] Data isolation at query layer (mandatory tenant_id filter)
- [x] Anonymization for peer benchmarks (percentiles, not names)
- [x] Pre-aggregated summaries (daily rollups, not live SUM)
- [x] Role-based access control (owner sees all, staff sees filtered)
- [x] Secure export (aggregates only, no PII)
- [x] Time-series partitioning (keeps indexes small)
- [x] Materialized views for complex queries
- [x] Cache invalidation strategy

**Interview Points:**

1. "How do you prevent Tenant A from seeing Tenant B's data?" → Mandatory tenant_id filter at query layer
2. "How do benchmarks work without leaking data?" → Anonymized aggregates (percentiles, counts)
3. "How do you handle growing data?" → Pre-aggregation, partitioning, archival
4. "What about export security?" → Only aggregates, never PII, role-based access
5. "Performance optimization?" → Materialized views, caching with invalidation

---

## Related Reading

- See [04-database-design/TENANT_SCOPED_QUERIES.md](../04-database-design/TENANT_SCOPED_QUERIES.md) for query patterns
- See [03-authorization-security/RBAC_IMPLEMENTATION_GUIDE.md](../03-authorization-security/RBAC_IMPLEMENTATION_GUIDE.md) for access control
