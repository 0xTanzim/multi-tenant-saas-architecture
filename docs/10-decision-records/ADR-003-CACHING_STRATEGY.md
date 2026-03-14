# ADR-003: Redis with Tenant-Namespaced Keys for Distributed Caching

**Status:** Accepted
**Date:** 2025-05-10
**Audience:** Backend Engineers, DevOps, Platform Architects
**Supersedes:** None
**Superseded By:** None

---

## Decision

We will use **Redis as the primary caching layer with tenant-namespaced keys** (format: `tenant:{tenantId}:{entityType}:{identifier}`) rather than adopting per-tenant Redis instances or in-memory application-level caching.

---

## Context

Caching is critical for SaaS platform performance. The salon booking system has latency-sensitive operations:

- Service availability lookup (real-time, high frequency)
- Staff schedule retrieval (high frequency during booking flow)
- Customer loyalty points computation (moderate frequency)
- Appointment availability slots (very high frequency during peak hours)

The platform must decide on a caching strategy that balances:

- **Isolation:** Prevent data leakage between tenants
- **Complexity:** Operational burden of running cache infrastructure
- **Performance:** Cache hit rates and latency
- **Scalability:** Support 1000s of tenants efficiently
- **Cost:** Balance infrastructure cost against performance gains

---

## Options Considered

### Option A: Shared Redis with Tenant-Namespaced Keys ✓ CHOSEN

**Implementation:**
Single shared Redis instance. All cache keys include tenant namespace: `tenant:{tenantId}:{entity}:{id}`.

**Cache Key Strategy:**

```typescript
// Pattern: tenant:{tenantId}:{entityType}:{identifier}

// Examples:
const serviceKey = `tenant:salon-123:service:456`; // Single service
const servicesKey = `tenant:salon-123:services:all`; // All services for salon
const staffScheduleKey = `tenant:salon-123:staff:789:schedule:2025-05-10`;
const customerLoyaltyKey = `tenant:salon-123:customer:999:loyalty`;

// TTL per entity type:
// Services: 1 hour (changes infrequently)
// Staff schedule: 15 minutes (changes moderately)
// Loyalty points: 5 minutes (computed on-demand, cached briefly)
// Availability slots: 2 minutes (high change frequency during peak)
```

**Implementation Pattern:**

```typescript
class RedisCache {
  private readonly redis: Redis;

  // Cache key builder
  private buildKey(
    tenantId: string,
    entityType: string,
    identifier: string
  ): string {
    return `tenant:${tenantId}:${entityType}:${identifier}`;
  }

  // Get with namespace safety
  async getService(
    tenantId: string,
    serviceId: string
  ): Promise<Service | null> {
    const key = this.buildKey(tenantId, 'service', serviceId);
    const cached = await this.redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  // Set with TTL and namespace
  async cacheService(
    tenantId: string,
    serviceId: string,
    data: Service,
    ttlSeconds: number
  ) {
    const key = this.buildKey(tenantId, 'service', serviceId);
    await this.redis.setex(key, ttlSeconds, JSON.stringify(data));
  }

  // Invalidate tenant data
  async invalidateTenantCache(tenantId: string): Promise<void> {
    // Use SCAN + pattern to find and delete all keys for tenant
    const pattern = `tenant:${tenantId}:*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
```

**Pros:**

- ✅ **Single Infrastructure:** One Redis instance to deploy, monitor, backup
- ✅ **Isolation by Convention:** Tenant namespace prevents accidental cross-tenant cache hits
- ✅ **Efficient Resource Usage:** Cache resources shared; hit rates improve with more tenants
- ✅ **Easy Invalidation:** `SCAN pattern` identifies all keys for a tenant; atomically invalidate
- ✅ **Cost-Effective:** Single Redis instance (not per-tenant)
- ✅ **Operational Simplicity:** Standard Redis monitoring tools work unchanged
- ✅ **TTL Management:** Per-key TTL easily configured based on entity type

**Cons:**

- ❌ **Noisy Neighbor Risk:** Tenant A's large cache footprint can evict Tenant B's entries
- ❌ **Key Collision Possibility:** Malformed keys could accidentally collide (requires discipline)
- ❌ **Isolation Weakness:** Namespace convention not enforced by Redis; application must respect it
- ❌ **Limited GDPR Compliance:** Right-to-be-forgotten requires pattern-matching scan + delete (not atomic)
- ❌ **Performance Unpredictability:** Memory pressure from other tenants affects eviction

---

### Option B: Per-Tenant Redis Instances

**Implementation:**
Each tenant provisioned with their own Redis instance (or Redis database/namespace).

**Topology:**

```
Redis Cluster
├── Tenant A
│   ├── service:456 → {name: "Haircut", ...}
│   ├── staff:789 → {name: "Alice", ...}
├── Tenant B
│   ├── service:111 → {name: "Manicure", ...}
│   ├── staff:222 → {name: "Bob", ...}
└── Tenant C
    ├── service:333 → {name: "Massage", ...}
```

**Connection Pattern:**

```typescript
class PerTenantRedisCache {
  private readonly redisConnections = new Map<string, Redis>();

  private getConnection(tenantId: string): Redis {
    if (!this.redisConnections.has(tenantId)) {
      // Connect to tenant-specific Redis instance
      this.redisConnections.set(
        tenantId,
        new Redis({
          host: `redis-${tenantId}.internal`,
          port: 6379,
        })
      );
    }
    return this.redisConnections.get(tenantId)!;
  }

  async getService(
    tenantId: string,
    serviceId: string
  ): Promise<Service | null> {
    const redis = this.getConnection(tenantId);
    const cached = await redis.get(`service:${serviceId}`);
    return cached ? JSON.parse(cached) : null;
  }
}
```

**Pros:**

- ✅ **Complete Isolation:** Each tenant's cache independent; no noisy neighbor risk
- ✅ **Predictable Performance:** Tenant's cache hit rate unaffected by others
- ✅ **GDPR Simplicity:** Tenant deletion = flush entire Redis instance (atomic)
- ✅ **Cache Tuning:** Each tenant can be allocated different Redis memory/performance level
- ✅ **Security Confidence:** Cryptographically impossible for cache entries to cross tenants

**Cons:**

- ❌ **Operational Complexity:** Provision, monitor, backup Redis for each tenant
- ❌ **Higher Infrastructure Costs:** N Redis instances instead of 1
- ❌ **Connection Pooling Overhead:** Application must manage connections to many Redis instances
- ❌ **Scaling Limits:** Practically limited to 100s of tenants (connection, memory overhead)
- ❌ **Failover Complexity:** If Redis for one tenant fails, affects only that tenant (good) but requires independent failover (complex)
- ❌ **Onboarding Delay:** New tenant registration requires Redis provisioning

---

### Option C: In-Memory Application Cache

**Implementation:**
Application-level caching using Node.js in-memory data structures (e.g., `Map`, LRU cache library like `lru-cache`).

**Pattern:**

```typescript
import LRU from 'lru-cache';

class InMemoryCache {
  private cache = new LRU<string, any>({
    max: 1000, // Max entries
    ttl: 1000 * 60 * 5, // 5 minute TTL
  });

  private buildKey(tenantId: string, entity: string, id: string): string {
    return `${tenantId}:${entity}:${id}`;
  }

  get(tenantId: string, entity: string, id: string): any {
    return this.cache.get(this.buildKey(tenantId, entity, id));
  }

  set(tenantId: string, entity: string, id: string, value: any) {
    this.cache.set(this.buildKey(tenantId, entity, id), value);
  }
}
```

**Pros:**

- ✅ **Simplicity:** No external infrastructure; cache built into application
- ✅ **Low Latency:** In-memory access faster than network round-trip to Redis
- ✅ **No Operational Burden:** Nothing to deploy/monitor/backup
- ✅ **Development Speed:** Immediate testing without Redis setup

**Cons:**

- ❌ **Not Shared Across Instances:** Each application instance has isolated cache; limited hit rate in multi-instance deployments
- ❌ **Memory Overhead:** Cache takes memory from application; limits cache size
- ❌ **Isolation Risk:** No tenant namespacing enforced; accidental code bug = cross-tenant data leak
- ❌ **Invalidation Complexity:** Updating data requires coordinating cache invalidation across all instances (message queue needed)
- ❌ **Limited Scale:** In-memory cache size capped by server RAM
- ❌ **Distributed System Challenge:** No built-in replication or failover
- ❌ **Not Suitable for Team Play:** Works for single-instance monolith; fails at scale

---

## Chosen Option

**Shared Redis with Tenant-Namespaced Keys (Option A)**

### Rationale

1. **Operational Practicality:** Single Redis instance is trivial to deploy (Docker container). Per-tenant Redis adds unacceptable management burden for growth-stage startup.

2. **Proven Pattern:** Tenant-namespaced keys are industry-standard for multi-tenant caching (Stripe, Twilio, Auth0 all use this approach).

3. **Cost Efficiency:** Single Redis instance serves 1000s of tenants at a fraction of the cost per-tenant instances.

4. **Scalability Path:** Architecture can later add Redis Cluster (multiple master nodes) without code changes. Each key's tenant namespace remains valid.

5. **GDPR Mitigation:** `SCAN tenant:{id}:*` pattern allows efficient bulk deletion for tenant offboarding. Good enough for compliance.

6. **In-Memory Not Viable:** Application-level caching insufficient for high-concurrency booking scenario (availability lookups hit cache 100s of times/second during peak).

7. **Noisy Neighbor Risk Manageable:** Monitored via cache eviction metrics. If problematic, can upgrade to Redis Cluster (horizontal scaling) or add per-tenant max memory limits (Redis 6.2+).

8. **Convention Over Configuration:** Team discipline to always use `tenant:{id}:...` pattern simple to enforce via code review and linting.

---

## Trade-Offs

| Aspect            | Shared Redis                      | Per-Tenant               | In-Memory                    |
| ----------------- | --------------------------------- | ------------------------ | ---------------------------- |
| **Isolation**     | Convention-based; not DB-enforced | Complete; database-level | High risk                    |
| **Infra Cost**    | Minimal (1 instance)              | High (N instances)       | None (app-level)             |
| **Complexity**    | Low (single instance)             | Medium (N connections)   | Low (but scaled up = Medium) |
| **Performance**   | High (shared hit rate)            | High (per-tenant)        | Highest (but local only)     |
| **Scalability**   | Scales to 1000s tenants           | Limited to 100s          | Single instance bottleneck   |
| **GDPR Deletion** | Pattern scan required             | Atomic flush             | Coordination needed          |

---

## Consequences

### Positive Consequences

✅ **Efficient Caching:** Cache benefits all tenants; hit rates improve as platform grows.

✅ **Operational Simplicity:** Deploy once, manage once. Standard Redis monitoring applies.

✅ **Cost-Effective:** Single Redis instance; minimal infrastructure overhead.

✅ **Scalability:** Can grow to 1000s of tenants without multiplying infrastructure.

✅ **Fast Onboarding:** New tenant immediately benefits from shared cache.

✅ **Familiar Patterns:** Developers understand Redis; tenant namespacing is industry-standard.

### Negative Consequences

❌ **Isolation Relies on Discipline:** Malformed cache key = potential cross-tenant leak.

❌ **Noisy Neighbor Risk:** Large tenant's cache footprint can evict smaller tenants' entries.

❌ **GDPR Complexity:** Deletion requires pattern scanning and deletion (not atomic).

❌ **Monitoring Burden:** Must track per-tenant cache hit rates to detect unfair resource usage.

❌ **Single Point of Failure:** Redis downtime affects all tenants (mitigation: Redis Cluster, failover).

---

## Enforcement Mechanisms

To mitigate risks of shared caching:

### 1. Cache Key Builder Pattern

```typescript
// Centralized, immutable cache key generation
export class CacheKeys {
  static service(tenantId: string, serviceId: string): string {
    return `tenant:${tenantId}:service:${serviceId}`;
  }

  static staffSchedule(
    tenantId: string,
    staffId: string,
    date: string
  ): string {
    return `tenant:${tenantId}:staff:${staffId}:schedule:${date}`;
  }

  // No ad-hoc key building allowed
  // Usage: await cache.get(CacheKeys.service(tenantId, serviceId))
}
```

**Enforcement:** All cache access must use `CacheKeys.*` static methods. Code review checks for ad-hoc key building.

### 2. Monitoring & Alerting

```typescript
// Track cache metrics per tenant
interface CacheMetrics {
  tenantId: string;
  hitRate: number;
  evictedEntries: number;
  memoryUsage: number;
  avgEntryAge: number;
}

// Alert if single tenant consuming >20% of cache
// Alert if eviction rate unusually high
```

### 3. Automated Testing

```typescript
describe('Cache Isolation', () => {
  it('should not return cached data for other tenants', async () => {
    const tenant1 = 'salon-1';
    const tenant2 = 'salon-2';

    await cache.set(CacheKeys.service(tenant1, 'svc-1'), { name: 'Haircut' });

    const result = await cache.get(CacheKeys.service(tenant2, 'svc-1'));
    expect(result).toBeNull(); // Should not retrieve other tenant's data
  });
});
```

### 4. Redis Monitoring

```bash
# Monitor cache eviction
redis-cli INFO stats | grep evicted_keys

# Identify large keys
redis-cli --bigkeys

# Monitor per-tenant memory usage (requires custom integration)
```

### 5. TTL Strategy by Entity Type

Prevent unbounded cache growth:

| Entity Type        | TTL        | Reason                   |
| ------------------ | ---------- | ------------------------ |
| Services           | 1 hour     | Rarely changes           |
| Staff schedules    | 15 minutes | Updated frequently       |
| Availability slots | 2 minutes  | Highest change frequency |
| Loyalty points     | 5 minutes  | Computed on-demand       |

---

## Migration Path: Shared Redis → Per-Tenant or Redis Cluster

If platform grows to 10,000+ tenants or isolation requirements tighten:

**Option 1: Scale to Redis Cluster**

- Upgrade from single instance to Redis Cluster (horizontal scaling)
- Cache key strategy unchanged (tenant namespace still valid)
- Automatic key distribution across cluster nodes
- Estimated effort: 1 sprint (infra only; no app code changes)

**Option 2: Migrate to Per-Tenant Redis**

- Extract cache key builder into abstraction
- Add tenant-based routing layer (switch instance based on tenant)
- Gradually migrate tenants to dedicated instances (blue-green)
- Estimated effort: 2-3 sprints

---

## Decision Log

**Approved by:** Architecture Review Board
**Approved Date:** 2025-05-10
**Implementation Started:** Q2 2025
**Related Issues:** PERF-0003, INFRA-0001
**Related ADRs:** ADR-001 (Shared Schema), ADR-002 (Application Filtering)

---

## References

- Redis Documentation: Best Practices
- Stripe Blog: Caching in Multi-Tenant Systems
- AWS ElastiCache Design Patterns
- [TENANT_ARCHITECTURE.md](../02-tenant-management/TENANT_ARCHITECTURE.md)
