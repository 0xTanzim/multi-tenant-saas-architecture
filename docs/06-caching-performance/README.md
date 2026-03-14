# Caching & Performance

Redis caching strategies, tenant-aware caching, and performance optimization.

## Files

### 1. **REDIS_CACHING_STRATEGY.md**

Redis patterns for multi-tenant systems.

- Key naming conventions: tenant:{id}:key
- Cache invalidation strategies
- TTL management
- Hot vs cold data

### 2. **TENANT_AWARE_CACHING.md**

Caching for multi-tenant isolation.

- Per-tenant cache keys
- Cache eviction on tenant deletion
- Cross-tenant cache contamination prevention
- Testing cache isolation

### 3. **PERFORMANCE_OPTIMIZATION.md**

General performance best practices.

- Query optimization
- N+1 query prevention
- Lazy loading strategies
- Batch operations

### 4. **CACHE_INVALIDATION_PATTERNS.md**

How to safely invalidate cached data.

- Event-driven invalidation
- Time-based expiration
- Manual invalidation
- Cascading invalidation

### 5. **OBSERVABILITY_AND_MONITORING.md**

Monitoring cache performance.

- Cache hit/miss rates
- Performance metrics
- Alerting strategies
- Debugging cache issues

## Cache Architecture

```
Request → Check Cache (Redis)
  ↓ HIT        ↓ MISS
Return data   Query DB → Store in Cache → Return data
```

## Tenant-Aware Cache Pattern

```typescript
// Key format: always include tenant_id
const key = `tenant:${tenantId}:resource:${resourceId}`;
await redis.set(key, data, { ex: 3600 }); // 1 hour TTL
```

## Reading Order

1. Start with REDIS_CACHING_STRATEGY.md (overview)
2. Read TENANT_AWARE_CACHING.md (multi-tenant context)
3. Explore CACHE_INVALIDATION_PATTERNS.md for maintenance
4. Use PERFORMANCE_OPTIMIZATION.md for tuning

## Performance Targets

- API response times < 100ms (cached)
- Cache hit rate > 80%
- No N+1 queries
- Database connection pooling active

---

**Related Files**:

- Database queries: `../04-database-design/TENANT_SCOPED_QUERIES.md`
- Deployment monitoring: `../08-deployment-operations/`
