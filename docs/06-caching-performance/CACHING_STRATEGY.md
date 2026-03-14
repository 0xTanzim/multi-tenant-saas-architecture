# Redis Caching Strategy for Multi-Tenant Systems

**Version:** 1.0
**Status:** Reference Implementation
**Audience:** Backend Engineers, DevOps, System Architects

---

## Table of Contents

1. [Overview](#overview)
2. [Redis Architecture](#redis-architecture)
3. [Cache Layers](#cache-layers)
4. [Cache Invalidation Patterns](#cache-invalidation-patterns)
5. [TTL Strategies](#ttl-strategies)
6. [Cache Warming](#cache-warming)
7. [Distributed Caching Considerations](#distributed-caching-considerations)
8. [Monitoring & Observability](#monitoring--observability)

---

## Overview

Redis caching is essential for multi-tenant SaaS systems to achieve:

- **Low-latency responses** for frequently accessed data
- **Reduced database load** during peak traffic
- **Scalability** across multiple application instances
- **Real-time data availability** without sacrificing performance

**Key Principle**: Caching is a **performance optimization**, not a source of truth. The database is always authoritative. Caching failures must gracefully degrade to database queries.

### Cache Types by Function

| Cache Type        | Purpose                                         | TTL          | Invalidation         |
| ----------------- | ----------------------------------------------- | ------------ | -------------------- |
| **Query Result**  | Frequent read queries (availability, schedules) | 5-30 min     | Explicit on mutation |
| **Computed Data** | Derived/aggregated data (analytics, stats)      | 10-60 min    | Scheduled refresh    |
| **Session**       | User session data                               | 24 hours     | On logout            |
| **Configuration** | Tenant settings, feature flags                  | 30-60 min    | Immediate on update  |
| **Catalog**       | Services, staff, products                       | 1 hour       | Explicit on change   |
| **Lock**          | Distributed locks (booking conflicts)           | 5-30 seconds | Explicit release     |

---

## Redis Architecture

### Deployment Model: Shared Redis with Tenant Isolation

```
┌─────────────────────────────────────────────────────┐
│          Redis Instance (Single or Cluster)         │
├─────────────────────────────────────────────────────┤
│  Key Namespace: tenant:{id}:cache_type:resource_id │
│                                                     │
│  Tenant A      Tenant B      Tenant C              │
│  ├─ schedule   ├─ bookings   ├─ staff              │
│  ├─ config     ├─ config     ├─ services           │
│  └─ analytics  └─ analytics  └─ locks              │
└─────────────────────────────────────────────────────┘
```

### Connection Pool Configuration

```typescript
// Connection pooling prevents exhaustion under load
const redisOptions = {
  host: 'redis.example.com',
  port: 6379,
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  enableOfflineQueue: true,
  connectTimeout: 5000,
  retryStrategy: (times: number) => Math.min(times * 50, 1000),

  // Cluster-specific
  cluster: [
    { host: 'redis-1.example.com', port: 6379 },
    { host: 'redis-2.example.com', port: 6379 },
  ],
};
```

### Redis Data Structure Selection

| Data Type      | Use Case                           | Example                    |
| -------------- | ---------------------------------- | -------------------------- |
| **String**     | Simple values, serialized objects  | Cache query results        |
| **Hash**       | Object fields with independent TTL | User profile data          |
| **List**       | Ordered sequences                  | Event logs, queues         |
| **Set**        | Unique collections                 | Session IDs, feature flags |
| **Sorted Set** | Ranked or time-ordered             | Leaderboards, recent items |

---

## Cache Layers

### Layer 1: Application-Level Caching

**Scope**: In-memory cache within application process
**Purpose**: Reduce Redis round-trips
**TTL**: 1-5 minutes (short, to avoid data staleness)

```typescript
// Local in-memory cache with TTL
const localCache = new Map<string, { value: any; expires: number }>();

function getFromLocalCache<T>(key: string): T | null {
  const cached = localCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expires) {
    localCache.delete(key);
    return null;
  }
  return cached.value as T;
}

function setLocalCache<T>(key: string, value: T, ttlMs: number = 300000): void {
  localCache.set(key, {
    value,
    expires: Date.now() + ttlMs,
  });
}
```

**Trade-off**: Memory vs. Consistency. Use only for truly immutable data (settings, configuration).

### Layer 2: Distributed Redis Cache

**Scope**: Shared across all application instances
**Purpose**: Reduce database queries
**TTL**: 5-60 minutes (balanced for consistency and performance)

```typescript
// Redis cache with tenant scoping
async function getAvailability(
  tenantId: string,
  staffId: string
): Promise<Availability | null> {
  const cacheKey = `tenant:${tenantId}:availability:${staffId}`;

  // Try Redis first
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Fall back to database
  const availability = await db.query.availability.findFirst({
    where: (a, { eq, and }) =>
      and(eq(a.tenant_id, tenantId), eq(a.staff_id, staffId)),
  });

  // Cache result
  if (availability) {
    await redisClient.setex(
      cacheKey,
      1800, // 30 minutes
      JSON.stringify(availability)
    );
  }

  return availability;
}
```

### Layer 3: Query-Level Caching

**Scope**: Cache entire query results
**Purpose**: Avoid repeated database roundtrips
**TTL**: 5-30 minutes

```typescript
// Cache entire result set
async function listServices(tenantId: string): Promise<Service[]> {
  const cacheKey = `tenant:${tenantId}:services:list`;

  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const services = await db.query.services.findMany({
    where: (s, { eq }) => eq(s.tenant_id, tenantId),
  });

  await redisClient.setex(cacheKey, 600, JSON.stringify(services));
  return services;
}
```

---

## Cache Invalidation Patterns

### Pattern 1: Time-Based Invalidation (TTL)

**When**: Data changes infrequently
**How**: Set TTL at cache write time
**Pro**: Simple, no coordination needed
**Con**: Potential stale data until TTL expires

```typescript
// Short TTL for frequently-accessed data
await redis.setex(`tenant:${id}:config`, 300, JSON.stringify(config)); // 5 min

// Long TTL for rarely-changing data
await redis.setex(`tenant:${id}:settings`, 3600, JSON.stringify(settings)); // 1 hour
```

### Pattern 2: Event-Based Invalidation (Explicit)

**When**: Data changes frequently or staleness is critical
**How**: Invalidate on mutation events
**Pro**: Immediate consistency
**Con**: Requires careful event handling

```typescript
// Invalidate on mutation
async function updateService(tenantId: string, serviceId: string, data: Service): Promise<void> {
  // Update database
  await db.update(services).set(data).where(...);

  // Invalidate related caches
  await redis.del(`tenant:${tenantId}:services:list`);
  await redis.del(`tenant:${tenantId}:service:${serviceId}`);
  await redis.del(`tenant:${tenantId}:availability:*`); // Pattern matching
}
```

### Pattern 3: Write-Through Caching

**When**: Data must be consistent immediately
**How**: Write to cache AND database as atomic operation
**Pro**: Guaranteed consistency
**Con**: Slightly slower writes

```typescript
async function createBooking(
  tenantId: string,
  booking: Booking
): Promise<Booking> {
  // Write to database first (source of truth)
  const created = await db.insert(bookings).values({
    ...booking,
    tenant_id: tenantId,
  });

  // Then update cache
  await redis.set(
    `tenant:${tenantId}:booking:${created.id}`,
    JSON.stringify(created)
  );

  // Invalidate list cache
  await redis.del(`tenant:${tenantId}:bookings:list`);

  return created;
}
```

### Pattern 4: Cache-Aside (Lazy Loading)

**When**: Data is accessed sporadically
**How**: Load from cache if available; otherwise load from database and populate cache
**Pro**: Efficient for sparse access
**Con**: First access is slow (cold start)

```typescript
async function getBooking(
  tenantId: string,
  bookingId: string
): Promise<Booking | null> {
  const cacheKey = `tenant:${tenantId}:booking:${bookingId}`;

  // Check cache first
  let cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Load from database (cache miss)
  const booking = await db.query.bookings.findFirst({
    where: (b, { eq, and }) =>
      and(eq(b.tenant_id, tenantId), eq(b.id, bookingId)),
  });

  // Populate cache for future requests
  if (booking) {
    await redis.setex(cacheKey, 1800, JSON.stringify(booking));
  }

  return booking;
}
```

### Cache Invalidation Anti-Patterns

❌ **NEVER DO THESE**:

1. **Orphaned Keys**: Cache keys that are never invalidated → memory leak

   ```typescript
   // ❌ BAD: No invalidation strategy
   await redis.set(`data:${key}`, value); // TTL not set, grows forever
   ```

2. **Cascading Invalidations**: Invalidating too broadly → defeats caching purpose

   ```typescript
   // ❌ BAD: Invalidates entire tenant cache on small change
   await redis.flushdb(); // Clears ALL tenants!
   ```

3. **Silent Cache Failures**: Not handling Redis errors → can crash system

   ```typescript
   // ❌ BAD: If Redis is down, entire operation fails
   const cached = await redis.get(key);
   ```

4. **Missing Tenant Filter**: Invalidating other tenant's data

   ```typescript
   // ❌ BAD: Invalidates ALL tenants
   await redis.del(`services:list`);

   // ✅ CORRECT: Tenant-scoped
   await redis.del(`tenant:${tenantId}:services:list`);
   ```

---

## TTL Strategies

### Dynamic TTL Based on Data Stability

```typescript
interface CacheConfig {
  key: string;
  ttlSeconds: number;
  invalidateOn?: string[]; // Events that invalidate cache
}

const CACHE_CONFIGS: Record<string, CacheConfig> = {
  // Highly stable data: long TTL
  TENANT_SETTINGS: { key: 'tenant:settings', ttlSeconds: 3600 }, // 1 hour
  SERVICES_LIST: { key: 'tenant:services:list', ttlSeconds: 1800 }, // 30 min

  // Frequently changing: short TTL
  STAFF_AVAILABILITY: { key: 'tenant:staff:availability', ttlSeconds: 300 }, // 5 min
  BOOKING_COUNT: { key: 'tenant:bookings:count', ttlSeconds: 60 }, // 1 min

  // Real-time critical: minimal or no cache
  PAYMENT_STATUS: { key: 'tenant:payment:status', ttlSeconds: 30 }, // 30 sec
  STOCK_LEVELS: { key: 'tenant:stock', ttlSeconds: 0 }, // No cache
};
```

### Adaptive TTL Based on Data Age

```typescript
function calculateAdaptiveTTL(lastModified: Date): number {
  const ageHours = (Date.now() - lastModified.getTime()) / (1000 * 60 * 60);

  if (ageHours > 24) {
    return 3600; // 1 hour - very stable data
  } else if (ageHours > 1) {
    return 600; // 10 min - moderately stable
  } else {
    return 60; // 1 min - recently modified
  }
}
```

---

## Cache Warming

### Strategy 1: Eager Loading on Startup

```typescript
async function warmCacheOnStartup(tenantId: string): Promise<void> {
  // Pre-load critical data into Redis
  const [services, staff, settings] = await Promise.all([
    db.query.services.findMany({ where: { tenant_id: tenantId } }),
    db.query.staff.findMany({ where: { tenant_id: tenantId } }),
    tenantSettingsService.get(tenantId),
  ]);

  // Populate Redis
  await Promise.all([
    redis.setex(
      `tenant:${tenantId}:services:list`,
      3600,
      JSON.stringify(services)
    ),
    redis.setex(`tenant:${tenantId}:staff:list`, 3600, JSON.stringify(staff)),
    redis.setex(`tenant:${tenantId}:settings`, 3600, JSON.stringify(settings)),
  ]);

  logger.info(`Cache warmed for tenant ${tenantId}`);
}
```

### Strategy 2: Scheduled Refresh

```typescript
// Run every 30 minutes
async function refreshPopularCaches(): Promise<void> {
  const tenants = await db.query.tenants.findMany();

  for (const tenant of tenants) {
    // Refresh popular queries
    const services = await db.query.services.findMany({
      where: { tenant_id: tenant.id },
    });

    await redis.setex(
      `tenant:${tenant.id}:services:list`,
      1800,
      JSON.stringify(services)
    );
  }
}

// Schedule with cron
schedule.scheduleJob('*/30 * * * *', refreshPopularCaches);
```

### Strategy 3: Lazy Warming on First Request

```typescript
async function getServicesWithWarming(tenantId: string): Promise<Service[]> {
  const cacheKey = `tenant:${tenantId}:services:list`;

  // Try cache
  let cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Load from DB and cache
  const services = await db.query.services.findMany({
    where: { tenant_id: tenantId },
  });

  // Warm related caches too
  await Promise.all([
    redis.setex(cacheKey, 1800, JSON.stringify(services)),
    // Also cache individual services
    ...services.map((s) =>
      redis.setex(`tenant:${tenantId}:service:${s.id}`, 1800, JSON.stringify(s))
    ),
  ]);

  return services;
}
```

---

## Distributed Caching Considerations

### Multi-Instance Coordination

```typescript
// Broadcast cache invalidation across all instances
class CacheInvalidationBroadcaster {
  async invalidate(tenantId: string, key: string): Promise<void> {
    // Delete from local Redis
    await redis.del(`tenant:${tenantId}:${key}`);

    // Publish invalidation event
    await pubSub.publish(`cache:invalidate:${tenantId}`, {
      key,
      timestamp: Date.now(),
    });
  }
}

// Subscribe on app startup
pubSub.subscribe(`cache:invalidate:${tenantId}`, (event) => {
  logger.debug(`Cache invalidated: ${event.key}`);
  // Local cleanup if needed
});
```

### Cache Stampede Prevention

**Problem**: Multiple requests all miss cache and hit database simultaneously

```typescript
// Distributed lock prevents stampede
async function getAvailabilityWithLocking(
  tenantId: string,
  staffId: string
): Promise<Availability> {
  const cacheKey = `tenant:${tenantId}:availability:${staffId}`;
  const lockKey = `lock:${cacheKey}`;

  // Try cache first
  let cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Try to acquire lock
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');

  if (acquired === 'OK') {
    try {
      // We got the lock: load from DB and update cache
      const data = await db.query.availability.findFirst({ ... });
      await redis.setex(cacheKey, 300, JSON.stringify(data));
      return data;
    } finally {
      // Release lock
      await redis.del(lockKey);
    }
  } else {
    // Lock held by another request
    // Wait and retry from cache
    await new Promise((r) => setTimeout(r, 50));
    cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    // Fall back to direct DB query
    return db.query.availability.findFirst({ ... });
  }
}
```

### Redis Cluster vs. Sentinel

| Aspect          | Redis Cluster                | Redis Sentinel               |
| --------------- | ---------------------------- | ---------------------------- |
| **Replication** | Automatic sharding           | Primary-replica              |
| **Failover**    | Automatic partition handling | Sentinel monitors & promotes |
| **Consistency** | Eventual (async replication) | Strong (within replica lag)  |
| **Complexity**  | High (16384 slots)           | Low (simple failover)        |
| **Scale**       | Horizontal (add nodes)       | Vertical (bigger nodes)      |
| **Use Case**    | High-throughput, distributed | High availability, simpler   |

---

## Monitoring & Observability

### Key Metrics to Track

```typescript
interface CacheMetrics {
  hits: number; // Successful cache reads
  misses: number; // Cache misses (DB fallback)
  evictions: number; // Keys removed due to memory
  memory_used: number; // Bytes used
  connected_clients: number; // Active connections
  commands_per_sec: number; // Throughput
}

// Hit ratio = hits / (hits + misses)
const hitRatio = metrics.hits / (metrics.hits + metrics.misses);
console.log(`Cache hit ratio: ${(hitRatio * 100).toFixed(2)}%`);
```

### Health Check Pattern

```typescript
async function checkRedisHealth(): Promise<boolean> {
  try {
    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;

    if (latency > 1000) {
      logger.warn(`Redis latency high: ${latency}ms`);
    }

    return true;
  } catch (error) {
    logger.error('Redis health check failed:', error);
    return false;
  }
}
```

### Logging Pattern

```typescript
function logCacheOperation(
  operation: 'hit' | 'miss' | 'set' | 'delete',
  tenantId: string,
  key: string,
  duration: number
): void {
  logger.debug(`[CACHE] ${operation.toUpperCase()}`, {
    tenant_id: tenantId,
    cache_key: key,
    duration_ms: duration,
    timestamp: new Date().toISOString(),
  });
}
```

---

## Summary

| Pattern           | Use Case             | TTL      | Invalidation         |
| ----------------- | -------------------- | -------- | -------------------- |
| **Time-Based**    | Stable data          | 5-60 min | TTL expiry           |
| **Event-Based**   | Changing data        | 5-30 min | Explicit on mutation |
| **Write-Through** | Critical consistency | 5-30 min | Immediate sync       |
| **Cache-Aside**   | Sparse access        | 5-30 min | TTL + explicit       |

**Key Principles**:

1. Database is source of truth
2. Cache failures must gracefully degrade
3. Always tenant-scope cache keys
4. Monitor hit ratios and latency
5. Plan for cache warming on startup
