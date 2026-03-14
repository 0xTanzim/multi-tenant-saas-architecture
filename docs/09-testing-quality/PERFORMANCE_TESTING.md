# Performance Testing & Load Validation

## Overview

Performance testing in multi-tenant systems validates that the platform scales efficiently across independent tenant environments. This document covers load testing strategies, performance regression detection, database query benchmarks, cache effectiveness, and capacity planning.

---

## 1. Performance Testing Pyramid

```
           ╱╲
          ╱  ╲        Capacity Tests (Quarterly)
         ╱────╲       - 1000+ concurrent users
        ╱      ╲      - Multi-day endurance
       ╱ Stress ╲     - Failure scenarios
      ╱          ╲
     ╱────────────╲
    ╱              ╲   Load Tests (Weekly)
   ╱ Load Testing   ╲  - Normal throughput
  ╱                  ╲ - Mixed tenant scenarios
 ╱──────────────────╲
╱   Benchmark Tests   ╲ (Every commit)
╱  (Unit Performance)  ╲ - Query latency
────────────────────── - Cache hit rates
                        - Transformation speed
```

---

## 2. Benchmark Tests (Unit Performance)

### 2.1 Query Performance Benchmarks

```typescript
describe('Performance: Query Benchmarks', () => {
  test('findByTenantId should complete < 50ms for 10k bookings', async () => {
    const tenant = await createTenant();

    // Seed 10k bookings
    const bookings = await seedBookings(tenant.id, 10000);

    // Measure query time
    const start = performance.now();
    const results = await bookingService.findByTenantId(tenant.id);
    const duration = performance.now() - start;

    // Assert performance
    expect(duration).toBeLessThan(50); // 50ms threshold
    expect(results).toHaveLength(10000);

    console.log(`Query time: ${duration.toFixed(2)}ms`);
  });

  test('findById with tenant filter should complete < 10ms', async () => {
    const tenant = await createTenant();
    const booking = await createBooking(tenant.id);

    const start = performance.now();
    const result = await bookingService.findById(booking.id, tenant.id);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(10);
    console.log(`Point query time: ${duration.toFixed(2)}ms`);
  });

  test('pagination query should complete < 100ms', async () => {
    const tenant = await createTenant();
    await seedBookings(tenant.id, 50000);

    const start = performance.now();
    const result = await bookingService.findPaginated(tenant.id, {
      page: 1,
      pageSize: 50,
    });
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);
    console.log(`Paginated query: ${duration.toFixed(2)}ms`);
  });

  test('aggregation query should complete < 200ms', async () => {
    const tenant = await createTenant();
    await seedBookings(tenant.id, 10000);

    const start = performance.now();
    const stats = await analyticsService.getBookingStats(tenant.id);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(200);
    console.log(`Aggregation query: ${duration.toFixed(2)}ms`);
  });
});
```

### 2.2 Data Transformation Benchmarks

```typescript
describe('Performance: Data Transformation', () => {
  test('DTO mapping should complete < 5ms for 100 items', async () => {
    const bookings = Array.from({ length: 100 }, (_, i) => ({
      id: `booking-${i}`,
      customerId: `customer-${i}`,
      startTime: new Date(),
      price: 100,
    }));

    const start = performance.now();
    const dtos = bookings.map((b) => bookingMapper.toPresentationDto(b));
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(5);
    console.log(`Transform 100 items: ${duration.toFixed(2)}ms`);
  });

  test('permission resolution should complete < 2ms per request', async () => {
    const user = await createUser();
    const resource = 'bookings';
    const action = 'read';

    const start = performance.now();
    const canAccess = await permissionService.can(
      user.id,
      `${resource}:${action}`
    );
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(2);
    console.log(`Permission check: ${duration.toFixed(2)}ms`);
  });
});
```

### 2.3 Cache Effectiveness Benchmarks

```typescript
describe('Performance: Cache Effectiveness', () => {
  test('cached query should be 10x faster than uncached', async () => {
    const tenant = await createTenant();
    const booking = await createBooking(tenant.id);

    // First query (cache miss)
    const start1 = performance.now();
    await bookingService.findById(booking.id, tenant.id);
    const duration1 = performance.now() - start1;

    // Second query (cache hit)
    const start2 = performance.now();
    await bookingService.findById(booking.id, tenant.id);
    const duration2 = performance.now() - start2;

    // Cached should be significantly faster
    expect(duration2).toBeLessThan(duration1 / 3); // 3x or better
    console.log(
      `Uncached: ${duration1.toFixed(2)}ms, Cached: ${duration2.toFixed(2)}ms`
    );
  });

  test('cache hit rate should exceed 70% in normal operations', async () => {
    const tenant = await createTenant();
    const cache = new CacheService();

    let hits = 0;
    let total = 0;

    // Simulate normal operations
    for (let i = 0; i < 100; i++) {
      total++;
      const result = await cache.get(`tenant:${tenant.id}:booking:1`, () =>
        bookingService.findById('1', tenant.id)
      );
      if (cache.wasHit()) hits++;
    }

    const hitRate = (hits / total) * 100;
    expect(hitRate).toBeGreaterThan(70);
    console.log(`Cache hit rate: ${hitRate.toFixed(1)}%`);
  });

  test('cache invalidation should clear related keys', async () => {
    const tenant = await createTenant();
    const booking = await createBooking(tenant.id);
    const cacheKey = `tenant:${tenant.id}:booking:${booking.id}`;

    // Populate cache
    await cache.set(cacheKey, booking);
    expect(await cache.get(cacheKey)).toBeDefined();

    // Invalidate
    await cache.invalidate(`tenant:${tenant.id}:booking:*`);

    // Should be empty
    expect(await cache.get(cacheKey)).toBeUndefined();
  });
});
```

---

## 3. Load Tests (Weekly)

### 3.1 Single Tenant Load Test

```typescript
// Load test with K6
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 10 }, // Warm-up
    { duration: '5m', target: 50 }, // Ramp-up
    { duration: '10m', target: 50 }, // Stay at load
    { duration: '5m', target: 0 }, // Ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(99)<500', 'p(95)<300'], // 99th percentile < 500ms
    http_req_failed: ['rate<0.1'], // Error rate < 10%
  },
};

export default function () {
  const tenantId = 'tenant-load-test-001';
  const token = __ENV.AUTH_TOKEN;

  // 1. Create booking
  const createRes = http.post(
    `${__ENV.API_URL}/api/bookings`,
    {
      title: 'Load Test Booking',
      customerId: 'customer-1',
      startTime: new Date().toISOString(),
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-ID': tenantId,
      },
    }
  );

  check(createRes, {
    'create status is 201': (r) => r.status === 201,
  });

  // 2. Read bookings
  const readRes = http.get(`${__ENV.API_URL}/api/bookings`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-ID': tenantId,
    },
  });

  check(readRes, {
    'read status is 200': (r) => r.status === 200,
    'response time < 300ms': (r) => r.timings.duration < 300,
  });

  sleep(1);
}
```

### 3.2 Multi-Tenant Load Test

```typescript
// Simulate multiple tenants under load simultaneously
export const options = {
  stages: [
    { duration: '2m', target: 100 }, // 100 VUs across multiple tenants
    { duration: '5m', target: 100 },
    { duration: '2m', target: 0 },
  ],
};

export default function () {
  // Each VU simulates a different tenant
  const tenantId = `tenant-${__VU}`; // VU = Virtual User number
  const token = generateTokenForTenant(tenantId);

  // Perform operations as this tenant
  const res = http.post(
    `${__ENV.API_URL}/api/bookings`,
    { title: 'Multi-tenant booking' },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-ID': tenantId,
      },
    }
  );

  check(res, {
    'status is 201': (r) => r.status === 201,
    'tenant isolation': (r) => {
      const data = JSON.parse(r.body);
      return data.tenantId === tenantId;
    },
  });

  sleep(Math.random() * 3);
}
```

### 3.3 Sustained Load Test

```typescript
// Run at constant load for extended period
export const options = {
  stages: [
    { duration: '30m', target: 50 }, // 30 minutes at 50 VUs
  ],
  thresholds: {
    http_req_duration: ['p(99)<500'],
    http_req_failed: ['rate<0.05'], // < 5% error
  },
};

export default function () {
  // Standard operations
  const tenantId = 'tenant-sustained-test';

  // List bookings
  http.get(`${__ENV.API_URL}/api/bookings`, {
    headers: { 'X-Tenant-ID': tenantId },
  });

  // Create booking
  http.post(`${__ENV.API_URL}/api/bookings`, {
    title: 'Test',
  });

  // Update booking
  http.put(`${__ENV.API_URL}/api/bookings/123`, {
    status: 'completed',
  });

  sleep(2);
}
```

---

## 4. Stress Tests (Monthly)

### 4.1 Failure Recovery Test

```typescript
describe('Performance: Failure Recovery', () => {
  test('system should recover from database connection loss', async () => {
    const tenant = await createTenant();
    const metrics = new PerformanceMetrics();

    // Normal operations
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await bookingService.findByTenantId(tenant.id);
      metrics.recordLatency(performance.now() - start);
    }

    const baselineP99 = metrics.getPercentile(99);

    // Simulate connection loss
    await database.disconnect();

    // Should queue requests
    const requests = Array.from({ length: 50 }, () =>
      bookingService.findByTenantId(tenant.id).catch(() => null)
    );

    // Reconnect
    await database.connect();

    // Requests should complete
    const results = await Promise.all(requests);
    expect(results.filter((r) => r).length).toBeGreaterThan(40); // > 80%

    // Performance should recover
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await bookingService.findByTenantId(tenant.id);
      metrics.recordLatency(performance.now() - start);
    }

    const recoveredP99 = metrics.getPercentile(99);
    expect(recoveredP99).toBeLessThan(baselineP99 * 1.5); // Within 50%
  });

  test('cache failover should maintain performance', async () => {
    const tenant = await createTenant();
    const metrics = new PerformanceMetrics();

    // Cache is working
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await bookingService.findById('1', tenant.id);
      metrics.recordLatency(performance.now() - start);
    }

    const cachedP99 = metrics.getPercentile(99);

    // Disable cache
    cache.disable();

    // Should still work, but slower
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await bookingService.findById('1', tenant.id);
      metrics.recordLatency(performance.now() - start);
    }

    const noCacheP99 = metrics.getPercentile(99);

    // Degraded but acceptable
    expect(noCacheP99).toBeLessThan(cachedP99 * 10); // Max 10x slower

    // Re-enable
    cache.enable();

    // Should recover
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await bookingService.findById('1', tenant.id);
      metrics.recordLatency(performance.now() - start);
    }

    const recoveredP99 = metrics.getPercentile(99);
    expect(recoveredP99).toBeLessThan(cachedP99 * 1.5);
  });
});
```

---

## 5. Regression Detection

### 5.1 Baseline Establishment

```typescript
// Establish performance baseline
export interface PerformanceBaseline {
  queryLatencyP95: number; // ms
  queryLatencyP99: number; // ms
  cacheHitRate: number; // %
  errorRate: number; // %
  throughput: number; // requests/sec
}

async function establishBaseline(): Promise<PerformanceBaseline> {
  const results = {
    latencies: [],
    errors: 0,
    total: 0,
  };

  // Run 1000 representative queries
  for (let i = 0; i < 1000; i++) {
    try {
      const start = performance.now();
      await bookingService.findByTenantId('tenant-001');
      results.latencies.push(performance.now() - start);
    } catch (e) {
      results.errors++;
    }
    results.total++;
  }

  results.latencies.sort((a, b) => a - b);

  return {
    queryLatencyP95:
      results.latencies[Math.floor(results.latencies.length * 0.95)],
    queryLatencyP99:
      results.latencies[Math.floor(results.latencies.length * 0.99)],
    cacheHitRate: 75, // Expected after warmup
    errorRate: results.errors / results.total,
    throughput:
      results.total / (results.latencies.reduce((a, b) => a + b) / 1000),
  };
}
```

### 5.2 Regression Testing

```typescript
describe('Performance Regression Detection', () => {
  let baseline: PerformanceBaseline;

  beforeAll(async () => {
    baseline = JSON.parse(fs.readFileSync('perf-baseline.json', 'utf-8'));
  });

  test('query latency should not regress > 10%', async () => {
    const metrics = new PerformanceMetrics();

    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await bookingService.findByTenantId('tenant-001');
      metrics.recordLatency(performance.now() - start);
    }

    const currentP99 = metrics.getPercentile(99);
    const threshold = baseline.queryLatencyP99 * 1.1; // 10% allowance

    expect(currentP99).toBeLessThan(threshold);

    if (currentP99 > baseline.queryLatencyP99) {
      console.warn(
        `⚠️ Query latency increased: ${currentP99.toFixed(2)}ms ` +
          `(baseline: ${baseline.queryLatencyP99.toFixed(2)}ms)`
      );
    }
  });

  test('cache hit rate should not decrease > 5%', async () => {
    const cache = new CacheService();
    let hits = 0;

    for (let i = 0; i < 1000; i++) {
      await cache.get('key', async () => 'value');
      if (cache.wasHit()) hits++;
    }

    const hitRate = (hits / 1000) * 100;
    const threshold = baseline.cacheHitRate * 0.95; // 5% allowance

    expect(hitRate).toBeGreaterThan(threshold);

    if (hitRate < baseline.cacheHitRate) {
      console.warn(
        `⚠️ Cache hit rate decreased: ${hitRate.toFixed(1)}% ` +
          `(baseline: ${baseline.cacheHitRate.toFixed(1)}%)`
      );
    }
  });
});
```

---

## 6. Capacity Planning

### 6.1 Capacity Test

```typescript
describe('Capacity Planning', () => {
  test('system should handle 100 concurrent users per tenant', async () => {
    const tenant = await createTenant();
    const concurrentUsers = 100;
    const operationsPerUser = 100;

    const results = {
      successes: 0,
      failures: 0,
      latencies: [],
    };

    // Simulate 100 concurrent users
    const promises = Array.from({ length: concurrentUsers }, async () => {
      for (let i = 0; i < operationsPerUser; i++) {
        try {
          const start = performance.now();
          await bookingService.findByTenantId(tenant.id);
          results.latencies.push(performance.now() - start);
          results.successes++;
        } catch (e) {
          results.failures++;
        }
      }
    });

    await Promise.all(promises);

    // Assertions
    expect(
      results.successes / (results.successes + results.failures)
    ).toBeGreaterThan(0.99); // > 99% success

    results.latencies.sort((a, b) => a - b);
    expect(
      results.latencies[Math.floor(results.latencies.length * 0.99)]
    ).toBeLessThan(500); // P99 < 500ms
  });

  test('should handle 1000s of tenants with minimal cross-tenant impact', async () => {
    const tenantCount = 1000;
    const tenants = await Promise.all(
      Array.from({ length: tenantCount }, () => createTenant())
    );

    const latencies = [];

    // Query from each tenant
    for (const tenant of tenants) {
      const start = performance.now();
      await bookingService.findByTenantId(tenant.id);
      latencies.push(performance.now() - start);
    }

    latencies.sort((a, b) => a - b);

    // All queries should be fast despite many tenants
    expect(latencies[Math.floor(latencies.length * 0.95)]).toBeLessThan(100);
    expect(latencies[Math.floor(latencies.length * 0.99)]).toBeLessThan(200);
  });
});
```

---

## 7. Performance Monitoring Dashboard

```typescript
interface PerformanceMetrics {
  timestamp: Date;
  endpoint: string;
  tenantId: string;
  method: string;
  statusCode: number;
  latency: number; // ms
  cacheHit: boolean;
  queryTime: number; // ms
  dbConnections: number;
  memoryUsage: number; // MB
}

// Store and visualize metrics
class PerformanceMonitor {
  async recordMetric(metric: PerformanceMetrics): Promise<void> {
    // Store in time-series database
    await timeseries.write(
      'performance_metrics',
      {
        endpoint: metric.endpoint,
        tenant_id: metric.tenantId,
        method: metric.method,
        status_code: metric.statusCode,
        latency_ms: metric.latency,
        cache_hit: metric.cacheHit,
        query_time_ms: metric.queryTime,
      },
      metric.timestamp
    );
  }

  async getLatencyPercentiles(
    endpoint: string,
    window: '1h' | '24h' = '1h'
  ): Promise<Percentiles> {
    const query = `
      SELECT
        PERCENTILE(latency_ms, 0.50) as p50,
        PERCENTILE(latency_ms, 0.95) as p95,
        PERCENTILE(latency_ms, 0.99) as p99
      FROM performance_metrics
      WHERE endpoint = '${endpoint}'
      AND time > now() - ${window}
    `;

    return timeseries.query(query);
  }
}
```

---

## 8. Quality Gates: Pre-Deployment Checks

```bash
#!/bin/bash

echo "🚀 Running Performance Validation..."

# 1. Run benchmark tests
npm test -- --testPathPattern="performance|benchmark" || exit 1

# 2. Check for regressions
npm run perf:regression || exit 1

# 3. Run load test (5 min at 50 VUs)
k6 run --duration 5m --vus 50 load-test.js || exit 1

# 4. Verify thresholds
npm run perf:verify-thresholds || exit 1

echo "✅ Performance validation PASSED"
```

---

## 9. Metrics to Track

| Metric         | Target       | Warning     | Critical    |
| -------------- | ------------ | ----------- | ----------- |
| P95 latency    | < 200ms      | > 250ms     | > 500ms     |
| P99 latency    | < 500ms      | > 600ms     | > 1000ms    |
| Error rate     | < 0.1%       | > 0.5%      | > 1%        |
| Cache hit rate | > 80%        | < 70%       | < 50%       |
| Throughput     | > 1000 req/s | < 800 req/s | < 500 req/s |
| Memory growth  | < 10%/day    | > 20%/day   | > 50%/day   |

---

## Next Steps

- **[TESTING_STRATEGY.md](./TESTING_STRATEGY.md)** — Return to testing strategy
- **[ISOLATION_TESTING.md](./ISOLATION_TESTING.md)** — Isolation testing
- **[Code Examples](./code-examples/testing/)** — Runnable performance tests
