# Performance Optimization & Observability

**Version:** 1.0
**Status:** Reference Implementation
**Audience:** Backend Engineers, DevOps, Performance Engineers

---

## Table of Contents

1. [Overview](#overview)
2. [Database Query Optimization](#database-query-optimization)
3. [Indexing Strategy](#indexing-strategy)
4. [N+1 Query Prevention](#n1-query-prevention)
5. [Connection Pooling](#connection-pooling)
6. [Monitoring & Observability](#monitoring--observability)
7. [Performance Targets](#performance-targets)
8. [Load Testing & Benchmarking](#load-testing--benchmarking)

---

## Overview

Multi-tenant SaaS systems face unique performance challenges:

1. **Tenant Scale**: Single database stores data for thousands of tenants
2. **Isolation Overhead**: Every query must filter by `tenant_id`
3. **Resource Contention**: Tenants share database connections and resources
4. **Compound Queries**: Complex joins across related data

**Performance Philosophy**: Measure → Optimize → Verify

```
Baseline Metrics → Identify Bottleneck → Targeted Fix → Regression Testing
    ↓                    ↓                      ↓              ↓
Establish SLOs    Profile with APM      Implement cache   Monitor in prod
```

---

## Database Query Optimization

### Pattern 1: Projection (Select Only Needed Columns)

**Problem**: Fetching entire table row when only 2-3 columns needed

```typescript
// ❌ WRONG: Fetches entire row (wasted bandwidth)
const bookings = await db.query.bookings.findMany({
  where: (b, { eq }) => eq(b.tenant_id, tenantId),
});

// ✅ CORRECT: Fetch only needed columns
const bookings = await db.query.bookings.findMany({
  columns: {
    id: true,
    booking_date: true,
    customer_id: true,
    // omit: status, notes, metadata, etc.
  },
  where: (b, { eq }) => eq(b.tenant_id, tenantId),
});

// Result: ~40% less data transferred from database
```

### Pattern 2: Eager Loading (Relations)

**Problem**: Lazy loading relations causes N+1 queries

```typescript
// ❌ WRONG: N+1 query problem
const bookings = await db.query.bookings.findMany({
  where: (b, { eq }) => eq(b.tenant_id, tenantId),
});

// Each booking triggers another query
for (const booking of bookings) {
  const customer = await db.query.customers.findFirst({
    where: (c, { eq }) => eq(c.id, booking.customer_id),
  }); // N queries total!
}

// ✅ CORRECT: Eager load relations with join
const bookings = await db.query.bookings.findMany({
  with: {
    customer: {
      columns: { id: true, name: true, email: true },
    },
    staff: {
      columns: { id: true, name: true },
    },
  },
  where: (b, { eq }) => eq(b.tenant_id, tenantId),
});

// 1 query + 2 joins, all data fetched together
```

### Pattern 3: Filtering at Database Level

**Problem**: Fetching all rows then filtering in application

```typescript
// ❌ WRONG: 1000 rows fetched, app filters to 10
const allBookings = await db.query.bookings.findMany({
  where: (b, { eq }) => eq(b.tenant_id, tenantId),
});

const completedBookings = allBookings.filter((b) => b.status === 'completed');

// ✅ CORRECT: Filter in SQL
const completedBookings = await db.query.bookings.findMany({
  where: (b, { eq, and }) =>
    and(eq(b.tenant_id, tenantId), eq(b.status, 'completed')),
});

// Result: 1 query, 10 rows returned (99% reduction)
```

### Pattern 4: Pagination for Large Result Sets

**Problem**: Fetching millions of rows into memory

```typescript
// ❌ WRONG: Fetch all customers (memory overflow)
const customers = await db.query.customers.findMany({
  where: (c, { eq }) => eq(c.tenant_id, tenantId),
});

// ✅ CORRECT: Paginate through results
async function* fetchCustomersInBatches(
  tenantId: string,
  pageSize: number = 1000
) {
  let offset = 0;

  while (true) {
    const batch = await db.query.customers.findMany({
      limit: pageSize,
      offset,
      where: (c, { eq }) => eq(c.tenant_id, tenantId),
      orderBy: (c) => c.id, // Consistent ordering
    });

    if (batch.length === 0) break;

    yield batch;
    offset += pageSize;
  }
}

// Usage
for await (const batch of fetchCustomersInBatches(tenantId)) {
  processCustomerBatch(batch);
}
```

---

## Indexing Strategy

### Index Type Selection

| Index Type             | Use Case                      | Example                     | Cost     |
| ---------------------- | ----------------------------- | --------------------------- | -------- |
| **Composite (B-tree)** | Primary filter + sort         | `(tenant_id, created_at)`   | Low      |
| **BRIN**               | Large tables, sequential data | `(tenant_id, booking_date)` | Very Low |
| **HASH**               | Equality only                 | `(tenant_id, customer_id)`  | Low      |
| **GiST**               | Range queries                 | Geospatial queries          | Medium   |
| **Full-Text**          | Text search                   | `(tenant_id, description)`  | High     |

### Essential Indexes for Multi-Tenant

```typescript
// Every tenant-scoped table needs these minimum indexes:

// 1. Primary tenant filter
db.schema.createIndex('idx_bookings_tenant', {
  columns: [tables.bookings.tenant_id],
  using: 'btree',
});

// 2. Tenant + status (common filter)
db.schema.createIndex('idx_bookings_tenant_status', {
  columns: [tables.bookings.tenant_id, tables.bookings.status],
  using: 'btree',
});

// 3. Tenant + date (range queries)
db.schema.createIndex('idx_bookings_tenant_date', {
  columns: [tables.bookings.tenant_id, tables.bookings.booking_date],
  using: 'btree',
});

// 4. Foreign key lookups
db.schema.createIndex('idx_bookings_customer_id', {
  columns: [tables.bookings.customer_id],
  using: 'btree',
});
```

### Index Cardinality Optimization

```typescript
// Check index effectiveness
async function analyzeIndexQuality(
  tableName: string,
  indexName: string
): Promise<void> {
  const result = await db.raw(sql`
    SELECT
      schemaname,
      tablename,
      indexname,
      idx_scan,
      idx_tup_read,
      idx_tup_fetch,
      ROUND(100.0 * idx_tup_fetch / NULLIF(idx_tup_read, 0), 2) as efficiency
    FROM pg_stat_user_indexes
    WHERE indexname = ${indexName}
  `);

  const { idx_scan, efficiency } = result.rows[0];

  console.log(`
    Index: ${indexName}
    Scans: ${idx_scan}
    Efficiency: ${efficiency}%
    ${efficiency < 50 ? '⚠️ CONSIDER DROPPING' : '✅ GOOD'}
  `);
}
```

### Index Maintenance

```typescript
// Rebuild fragmented indexes
async function rebuildFragmentedIndexes(): Promise<void> {
  const fragmented = await db.raw(sql`
    SELECT
      schemaname,
      tablename,
      indexname,
      ROUND(100 - (ROUND(pg_relation_size(indexrelid) /
        pg_relation_size(relid)::numeric, 4) * 100)::numeric, 2)
        AS bloat_ratio
    FROM pg_stat_user_indexes
    WHERE pg_relation_size(indexrelid) > 1000000
      AND (ROUND(100 - (ROUND(pg_relation_size(indexrelid) /
        pg_relation_size(relid)::numeric, 4) * 100)::numeric, 2)) > 20
  `);

  for (const idx of fragmented.rows) {
    console.log(`Rebuilding fragmented index: ${idx.indexname}`);
    await db.raw(
      sql`REINDEX INDEX CONCURRENTLY ${sql.identifier(idx.indexname)}`
    );
  }
}
```

---

## N+1 Query Prevention

### Detection: Query Watermark

```typescript
class QueryWatermarkDetector {
  private queryCount = 0;
  private queryLog: Array<{ sql: string; duration: number }> = [];

  async executeWithDetection<T>(
    operation: () => Promise<T>,
    threshold: number = 5
  ): Promise<T> {
    this.queryCount = 0;
    this.queryLog = [];

    // Hook into database driver
    const originalQuery = db.query;
    db.query = async (...args) => {
      this.queryCount++;
      const start = Date.now();
      const result = await originalQuery(...args);
      const duration = Date.now() - start;

      this.queryLog.push({
        sql: args[0],
        duration,
      });

      return result;
    };

    try {
      return await operation();
    } finally {
      db.query = originalQuery;

      if (this.queryCount > threshold) {
        console.warn(`N+1 DETECTED: ${this.queryCount} queries executed`);
        this.logQueries();
      }
    }
  }

  private logQueries(): void {
    console.table(
      this.queryLog.map((q) => ({
        queries: q.sql.substring(0, 50),
        ms: q.duration,
      }))
    );
  }
}
```

### Fix: Batch Loading with DataLoader

```typescript
import DataLoader from 'dataloader';

// Create batch loader for customers
const customerLoader = new DataLoader(async (customerIds) => {
  const customers = await db.query.customers.findMany({
    where: (c, { eq, inArray }) => inArray(c.id, customerIds),
  });

  // Return in same order as requested
  return customerIds.map((id) => customers.find((c) => c.id === id));
});

// Usage in queries
async function getBookingsWithCustomers(tenantId: string) {
  const bookings = await db.query.bookings.findMany({
    where: (b, { eq }) => eq(b.tenant_id, tenantId),
  });

  // DataLoader batches these requests
  const withCustomers = await Promise.all(
    bookings.map(async (b) => ({
      ...b,
      customer: await customerLoader.load(b.customer_id),
    }))
  );

  return withCustomers;
  // Result: 2 queries total (bookings + customers batch)
}
```

---

## Connection Pooling

### PostgreSQL Connection Pool Configuration

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  // Connection pool sizing
  max: 20, // Maximum connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 2000, // Timeout if pool exhausted

  // Query timeout
  query_timeout: 30000, // 30 second query timeout
});

// Monitor pool health
pool.on('error', (error) => {
  console.error('Unexpected pool error:', error);
});

pool.on('connect', () => {
  console.debug('New connection established');
});

pool.on('remove', () => {
  console.debug('Connection removed from pool');
});
```

### Pool Size Calculation

```
Expected_QPS = 100 queries per second
Avg_Query_Time = 50 milliseconds
Concurrency = (Expected_QPS * Avg_Query_Time) / 1000 = 5

Pool_Size = Concurrency * 2 (buffer for spikes) = 10
Min_Pool = 5
Max_Pool = 20
```

### Connection Health Check

```typescript
async function healthCheckPool(): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT 1');
    console.log('✅ Pool health: OK');
  } catch (error) {
    console.error('❌ Pool health: FAILED', error);
    throw error;
  } finally {
    client.release();
  }
}
```

---

## Monitoring & Observability

### Key Performance Indicators

```typescript
interface PerformanceMetrics {
  // Query performance
  average_query_latency_ms: number;
  p95_query_latency_ms: number;
  p99_query_latency_ms: number;
  queries_per_second: number;
  slow_queries_count: number; // > 1000ms

  // Cache performance
  cache_hit_ratio: number; // 0.0 to 1.0
  cache_evictions_per_minute: number;

  // Database connection
  active_connections: number;
  idle_connections: number;
  connection_pool_utilization: number; // 0.0 to 1.0

  // Application
  error_rate: number; // errors / total requests
  throughput_rps: number; // requests per second
}
```

### Structured Logging

```typescript
class PerformanceLogger {
  async logQuery(
    query: string,
    durationMs: number,
    tenantId: string,
    success: boolean,
    error?: Error
  ): Promise<void> {
    const isSlow = durationMs > 1000;

    console.log({
      level: isSlow ? 'warn' : 'debug',
      type: 'database_query',
      tenant_id: tenantId,
      duration_ms: durationMs,
      query: query.substring(0, 200), // Truncate for logging
      success,
      error: error?.message,
      timestamp: new Date().toISOString(),
    });

    // Store slow queries for analysis
    if (isSlow) {
      await db.insert(slow_queries).values({
        query,
        duration_ms: durationMs,
        tenant_id: tenantId,
        executed_at: new Date(),
      });
    }
  }
}
```

### APM Integration (DataDog Example)

```typescript
import { tracer } from 'dd-trace';

async function getBookingsWithTracing(tenantId: string) {
  const span = tracer.startSpan('bookings.list', {
    resource: '/api/bookings',
    type: 'web',
    tags: {
      tenant_id: tenantId,
      'service.name': 'booking-service',
    },
  });

  try {
    const bookings = await db.query.bookings.findMany({
      where: (b, { eq }) => eq(b.tenant_id, tenantId),
    });

    span.setTag('bookings.count', bookings.length);
    return bookings;
  } catch (error) {
    span.setTag('error', true);
    span.setTag('error.type', error.name);
    throw error;
  } finally {
    span.finish();
  }
}
```

---

## Performance Targets

### SLA Targets (Service Level Agreement)

| Metric              | Target  | Yellow | Red    |
| ------------------- | ------- | ------ | ------ |
| **P50 Latency**     | < 50ms  | 75ms   | 100ms  |
| **P95 Latency**     | < 200ms | 300ms  | 500ms  |
| **P99 Latency**     | < 500ms | 750ms  | 1000ms |
| **Error Rate**      | < 0.1%  | 0.5%   | 1.0%   |
| **Availability**    | > 99.9% | 99.5%  | 99.0%  |
| **Cache Hit Ratio** | > 80%   | 70%    | 50%    |

### Per-Endpoint Targets

```typescript
const ENDPOINT_TARGETS: Record<
  string,
  { p50: number; p95: number; p99: number }
> = {
  'GET /bookings': { p50: 50, p95: 150, p99: 300 },
  'POST /bookings': { p50: 200, p95: 500, p99: 1000 },
  'GET /availability': { p50: 30, p95: 100, p99: 200 },
  'GET /tenants/:id/config': { p50: 10, p95: 50, p99: 100 },
};
```

### Budget Tracking

```typescript
class PerformanceBudget {
  async checkBudget(endpoint: string, durationMs: number): Promise<void> {
    const target = ENDPOINT_TARGETS[endpoint];
    if (!target) return;

    if (durationMs > target.p99) {
      console.error(
        `BUDGET EXCEEDED: ${endpoint} took ${durationMs}ms (budget: ${target.p99}ms)`
      );
    } else if (durationMs > target.p95) {
      console.warn(
        `BUDGET WARNING: ${endpoint} took ${durationMs}ms (budget: ${target.p95}ms)`
      );
    }
  }
}
```

---

## Load Testing & Benchmarking

### Load Test Scenario

```typescript
import { performance } from 'perf_hooks';

async function loadTest(concurrency: number, duration: number): Promise<void> {
  const results = {
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    latencies: [] as number[],
  };

  const endTime = Date.now() + duration * 1000;
  const tasks: Promise<void>[] = [];

  for (let i = 0; i < concurrency; i++) {
    tasks.push(
      (async () => {
        while (Date.now() < endTime) {
          const start = performance.now();

          try {
            await fetch(`http://localhost:3000/api/bookings`, {
              headers: { 'x-tenant-id': 'test-tenant' },
            });
            results.successCount++;
          } catch (error) {
            results.errorCount++;
          }

          const duration = performance.now() - start;
          results.latencies.push(duration);
          results.totalRequests++;
        }
      })()
    );
  }

  await Promise.all(tasks);

  // Calculate statistics
  const sorted = results.latencies.sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];

  console.log(`
    Load Test Results (${concurrency} concurrent, ${duration}s):

    Throughput: ${(results.totalRequests / duration).toFixed(0)} req/s
    Success: ${results.successCount}
    Errors: ${results.errorCount}

    Latencies:
      P50: ${p50.toFixed(0)}ms
      P95: ${p95.toFixed(0)}ms
      P99: ${p99.toFixed(0)}ms
  `);
}

// Run load test
await loadTest(50, 60); // 50 concurrent clients for 60 seconds
```

### Regression Detection

```typescript
class PerformanceRegression {
  private baseline: Map<string, number> = new Map();

  recordBaseline(endpoint: string, p95Latency: number): void {
    this.baseline.set(endpoint, p95Latency);
  }

  checkRegression(
    endpoint: string,
    currentLatency: number,
    threshold: number = 1.1 // 10% tolerance
  ): void {
    const baselineLatency = this.baseline.get(endpoint);
    if (!baselineLatency) return;

    const ratio = currentLatency / baselineLatency;

    if (ratio > threshold) {
      console.error(
        `PERFORMANCE REGRESSION: ${endpoint} latency increased ${(
          (ratio - 1) *
          100
        ).toFixed(0)}%`
      );
    }
  }
}
```

---

## Optimization Checklist

- [ ] **Queries**: Projections, eager loading, filtering at DB level
- [ ] **Indexes**: Composite indexes on common filters
- [ ] **N+1**: Batch loading or DataLoader implemented
- [ ] **Pagination**: Large result sets paginated
- [ ] **Caching**: Query results cached with appropriate TTL
- [ ] **Connection Pooling**: Max/min configured appropriately
- [ ] **Monitoring**: APM instrumented for all critical paths
- [ ] **Load Testing**: Baseline latency established
- [ ] **Alerting**: Performance SLOs enforced
- [ ] **Documentation**: Performance targets documented

---

## Summary

**Optimization Flow**:

1. **Measure** → Establish baseline performance
2. **Identify** → Profile to find bottlenecks
3. **Optimize** → Apply patterns (indexes, caching, queries)
4. **Verify** → Load test to confirm improvement
5. **Monitor** → Track in production for regressions

**Key Principles**:

- Database is the bottleneck (95% of time)
- Indexes are cheap, cache misses are expensive
- Every tenant-scoped query must filter by `tenant_id` at DB level
- Cache layer prevents database saturation
- Distributed locks prevent thundering herd
- Monitoring detects regressions early
