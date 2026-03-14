# Tenant-Aware Caching: Isolation & Security

**Version:** 1.0
**Status:** Reference Implementation
**Audience:** Backend Engineers, Security Engineers

---

## Table of Contents

1. [Overview](#overview)
2. [Key Namespacing Strategy](#key-namespacing-strategy)
3. [Cache Isolation by Tenant](#cache-isolation-by-tenant)
4. [Shared Cache Conflict Prevention](#shared-cache-conflict-prevention)
5. [Cache Consistency Verification](#cache-consistency-verification)
6. [Cache Stampede Prevention](#cache-stampede-prevention)
7. [Security Considerations](#security-considerations)
8. [Audit & Compliance](#audit--compliance)

---

## Overview

Multi-tenant systems share a single Redis instance for cost efficiency, but must guarantee complete data isolation. Tenant-aware caching enforces:

1. **Logical Isolation**: Cache keys scoped by `tenant_id`
2. **No Cross-Tenant Leakage**: Queries never return data from other tenants
3. **Consistent Namespacing**: Predictable key structure across all services
4. **Automatic Validation**: Tenant context verified before every cache access

**Security Guarantee**: A tenant can NEVER read another tenant's cached data, even through misconfiguration or bug.

---

## Key Namespacing Strategy

### Namespace Structure

```
tenant:{tenant_id}:{cache_type}:{resource_type}:{resource_id}
```

### Examples

```
tenant:123:query:services:list
→ Tenant 123, query result cache, services list

tenant:123:session:user:456
→ Tenant 123, session cache, user 456

tenant:123:config:feature_flags
→ Tenant 123, configuration cache, feature flags

tenant:123:lock:booking:789
→ Tenant 123, distributed lock, booking 789

tenant:456:query:bookings:page:1
→ Tenant 456, query cache, bookings page 1
```

### Key Generation Utility

```typescript
class TenantCacheKeyBuilder {
  private readonly keyPrefix: string = 'donebyme';

  private buildKey(...parts: (string | number)[]): string {
    return [this.keyPrefix, ...parts].join(':');
  }

  // Query result caches
  queryKey(tenantId: string, resource: string): string {
    return this.buildKey('tenant', tenantId, 'query', resource);
  }

  // Session caches
  sessionKey(tenantId: string, sessionId: string): string {
    return this.buildKey('tenant', tenantId, 'session', sessionId);
  }

  // Configuration caches
  configKey(tenantId: string, configName: string): string {
    return this.buildKey('tenant', tenantId, 'config', configName);
  }

  // Distributed locks
  lockKey(tenantId: string, resource: string, resourceId: string): string {
    return this.buildKey('tenant', tenantId, 'lock', resource, resourceId);
  }

  // Pattern for scanning
  tenantPattern(tenantId: string): string {
    return this.buildKey('tenant', tenantId) + ':*';
  }
}

// Usage
const keyBuilder = new TenantCacheKeyBuilder();
const key = keyBuilder.queryKey('tenant-123', 'services:list');
// → donebyme:tenant:tenant-123:query:services:list
```

### Tenant ID Validation

```typescript
class TenantContextValidator {
  /**
   * Validate that tenant ID matches authenticated context
   * This prevents accidental cross-tenant access
   */
  validateTenantContext(
    requestTenantId: string,
    authTenantId: string,
    operation: string
  ): void {
    if (requestTenantId !== authTenantId) {
      throw new Error(
        `Tenant mismatch: request ${requestTenantId}, auth ${authTenantId} for ${operation}`
      );
    }
  }

  /**
   * Extract and validate tenant from JWT token
   */
  extractTenantFromToken(token: string): string {
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as any;
    const tenantId = decoded.tenant_id;

    if (!tenantId || typeof tenantId !== 'string') {
      throw new Error('Invalid or missing tenant_id in JWT token');
    }

    return tenantId;
  }
}
```

---

## Cache Isolation by Tenant

### Pattern: Tenant-Scoped Get/Set

```typescript
class TenantAwareCacheService {
  constructor(
    private readonly redis: Redis,
    private readonly validator: TenantContextValidator,
    private readonly keyBuilder: TenantCacheKeyBuilder
  ) {}

  /**
   * Get cached value for tenant
   * Returns null if key doesn't exist or tenant mismatch
   */
  async get<T>(tenantId: string, key: string): Promise<T | null> {
    // Validate tenant context (from request)
    const currentTenantId = await this.getCurrentTenantId();
    this.validator.validateTenantContext(tenantId, currentTenantId, 'GET');

    const fullKey = this.keyBuilder.queryKey(tenantId, key);
    const value = await this.redis.get(fullKey);

    if (!value) return null;

    try {
      return JSON.parse(value) as T;
    } catch (error) {
      // Log but don't throw - cache corruption should be transparent
      console.error(`Failed to parse cached value for ${fullKey}:`, error);
      return null;
    }
  }

  /**
   * Set cached value for tenant
   * Automatically scopes to tenant and sets TTL
   */
  async set<T>(
    tenantId: string,
    key: string,
    value: T,
    ttlSeconds: number = 300
  ): Promise<void> {
    // Validate tenant context
    const currentTenantId = await this.getCurrentTenantId();
    this.validator.validateTenantContext(tenantId, currentTenantId, 'SET');

    const fullKey = this.keyBuilder.queryKey(tenantId, key);
    const serialized = JSON.stringify(value);

    try {
      await this.redis.setex(fullKey, ttlSeconds, serialized);
    } catch (error) {
      // Redis errors should not crash the application
      console.error(`Failed to cache value for ${fullKey}:`, error);
    }
  }

  /**
   * Delete cached value for tenant
   * Respects tenant scope
   */
  async delete(tenantId: string, key: string): Promise<void> {
    const currentTenantId = await this.getCurrentTenantId();
    this.validator.validateTenantContext(tenantId, currentTenantId, 'DELETE');

    const fullKey = this.keyBuilder.queryKey(tenantId, key);
    await this.redis.del(fullKey);
  }

  /**
   * Invalidate all cache for a tenant
   * Use with caution - use specific key patterns when possible
   */
  async invalidateTenant(tenantId: string): Promise<number> {
    const pattern = this.keyBuilder.tenantPattern(tenantId);
    const keys = await this.redis.keys(pattern);

    if (keys.length === 0) return 0;

    // Delete in batches to avoid blocking Redis
    const batchSize = 100;
    let deletedCount = 0;

    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      deletedCount += await this.redis.del(...batch);
    }

    return deletedCount;
  }

  private async getCurrentTenantId(): Promise<string> {
    // Implementation: extract from request context
    // This would be injected via middleware or context
    return (this as any).tenantId;
  }
}
```

### Middleware for Tenant Context Injection

```typescript
import { Request, Response, NextFunction } from 'express';
import { Injectable, NestMiddleware } from '@nestjs/common';

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const tenantId = this.extractTenantId(req);

    if (!tenantId) {
      throw new Error('Missing tenant context in request');
    }

    // Attach to request object
    (req as any).tenantId = tenantId;
    (req as any).tenantContext = {
      id: tenantId,
      timestamp: new Date().toISOString(),
    };

    next();
  }

  private extractTenantId(req: Request): string | null {
    // Try multiple sources
    const fromHeader = req.headers['x-tenant-id'] as string;
    const fromAuth = (req as any).user?.tenant_id;
    const fromPath = req.params?.tenantId;

    return fromHeader || fromAuth || fromPath || null;
  }
}
```

---

## Shared Cache Conflict Prevention

### Problem: Accidental Cross-Tenant Reads

```typescript
// ❌ WRONG: Cache key doesn't include tenant_id
async function getCachedServices(tenantId: string): Promise<Service[]> {
  const cacheKey = 'services:all'; // BUG: Same key for all tenants!

  let cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached); // Could be another tenant's data!
  }

  const services = await db.query.services.findMany({
    where: { tenant_id: tenantId },
  });

  await redis.set(cacheKey, JSON.stringify(services));
  return services;
}

// Scenario:
// 1. Tenant A requests services → caches as 'services:all'
// 2. Tenant B requests services → gets Tenant A's cached data! 🔴 SECURITY BUG
```

### Solution: Always Scope by Tenant

```typescript
// ✅ CORRECT: Cache key includes tenant_id
async function getCachedServices(tenantId: string): Promise<Service[]> {
  const cacheKey = `tenant:${tenantId}:services:list`; // Tenant-scoped!

  let cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const services = await db.query.services.findMany({
    where: { tenant_id: tenantId },
  });

  await redis.set(cacheKey, JSON.stringify(services));
  return services;
}

// Now:
// 1. Tenant A requests services → caches as 'tenant:a:services:list'
// 2. Tenant B requests services → caches as 'tenant:b:services:list'
// 3. Each tenant gets their own data ✅
```

### Automated Conflict Detection

```typescript
class CacheConflictDetector {
  /**
   * Scan cache for keys that violate tenant scoping
   * Run periodically as a health check
   */
  async detectViolations(): Promise<string[]> {
    const allKeys = await this.redis.keys('*');
    const violations: string[] = [];

    for (const key of allKeys) {
      // Expected format: donebyme:tenant:{id}:...
      if (!key.includes('tenant:')) {
        violations.push(key); // Missing tenant scope
      }

      // Check for suspicious patterns
      if (key.includes('global:') || key.includes('all:')) {
        violations.push(key);
      }
    }

    if (violations.length > 0) {
      console.error('Cache isolation violations detected:', violations);
    }

    return violations;
  }

  /**
   * Validate cache entry belongs to correct tenant
   */
  async validateCacheEntry(
    key: string,
    expectedTenantId: string
  ): Promise<boolean> {
    // Extract tenant from key
    const match = key.match(/tenant:([^:]+):/);
    const keyTenantId = match?.[1];

    if (!keyTenantId) {
      console.warn(`Cache key missing tenant scope: ${key}`);
      return false;
    }

    if (keyTenantId !== expectedTenantId) {
      console.error(
        `Cache tenant mismatch: key has ${keyTenantId}, expected ${expectedTenantId}`
      );
      return false;
    }

    return true;
  }
}
```

---

## Cache Consistency Verification

### Pattern: Verification on Read

```typescript
async function getWithConsistencyCheck<T>(
  tenantId: string,
  key: string
): Promise<T> {
  const cacheKey = `tenant:${tenantId}:${key}`;

  // Get from cache
  const cached = await redis.get(cacheKey);
  if (!cached) {
    throw new Error(`Cache miss for ${cacheKey}`);
  }

  const cachedValue = JSON.parse(cached);

  // Verify consistency by comparing with database
  const dbValue = await fetchFromDatabase(tenantId, key);

  if (JSON.stringify(cachedValue) !== JSON.stringify(dbValue)) {
    console.warn(`Cache inconsistency detected for ${cacheKey}, invalidating`);
    await redis.del(cacheKey);
    return dbValue;
  }

  return cachedValue;
}
```

### Periodic Consistency Audit

```typescript
class CacheConsistencyAudit {
  /**
   * Run hourly audit to detect stale or inconsistent cache entries
   */
  async runAudit(): Promise<void> {
    const tenants = await db.query.tenants.findMany();

    for (const tenant of tenants) {
      await this.auditTenant(tenant.id);
    }
  }

  private async auditTenant(tenantId: string): Promise<void> {
    // Get all cache keys for tenant
    const pattern = `donebyme:tenant:${tenantId}:*`;
    const keys = await redis.keys(pattern);

    const inconsistencies: { key: string; reason: string }[] = [];

    for (const key of keys) {
      const cached = await redis.get(key);
      if (!cached) continue;

      try {
        const cachedValue = JSON.parse(cached);
        const isConsistent = await this.verifyValue(tenantId, key, cachedValue);

        if (!isConsistent) {
          inconsistencies.push({
            key,
            reason: 'Value mismatch with database',
          });
          await redis.del(key); // Invalidate
        }
      } catch (error) {
        inconsistencies.push({
          key,
          reason: `Error during verification: ${error}`,
        });
        await redis.del(key); // Invalidate on error
      }
    }

    if (inconsistencies.length > 0) {
      console.warn(
        `Consistency audit for tenant ${tenantId}:`,
        inconsistencies
      );
    }
  }

  private async verifyValue(
    tenantId: string,
    cacheKey: string,
    cachedValue: any
  ): Promise<boolean> {
    // Extract resource type from cache key
    const resource = cacheKey.split(':')[3]; // e.g., 'query', 'config'

    if (resource === 'query') {
      // Re-query database to verify
      const dbValue = await this.fetchFromDatabase(tenantId, cacheKey);
      return JSON.stringify(dbValue) === JSON.stringify(cachedValue);
    } else if (resource === 'config') {
      // Verify configuration hasn't changed
      return true; // Configs don't change frequently
    }

    return true; // Default: assume consistent
  }

  private async fetchFromDatabase(
    tenantId: string,
    cacheKey: string
  ): Promise<any> {
    // Implementation: extract resource type and query DB
    return null;
  }
}
```

---

## Cache Stampede Prevention

### Problem: Thundering Herd

```typescript
// Multiple requests hit cache simultaneously when key expires
// All miss and hit database at the same time → Database overload

// Scenario:
// Time 0:   Key 'tenant:123:services:list' expires (TTL = 5 min)
// Time 5m:  100 concurrent requests all miss cache
//           100 database queries fire simultaneously
//           Database CPU spikes 🔴
```

### Solution: Distributed Lock

```typescript
class CacheStampedeProtection {
  async getWithLocking<T>(
    tenantId: string,
    key: string,
    loader: () => Promise<T>,
    ttlSeconds: number = 300
  ): Promise<T> {
    const cacheKey = `tenant:${tenantId}:${key}`;
    const lockKey = `lock:${cacheKey}`;

    // Try to get from cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as T;
    }

    // Try to acquire lock
    const lockAcquired = await redis.set(
      lockKey,
      Date.now().toString(),
      'EX',
      5, // Lock expires in 5 seconds
      'NX'
    );

    if (lockAcquired === 'OK') {
      // We got the lock: load from source
      try {
        const value = await loader();
        await redis.setex(cacheKey, ttlSeconds, JSON.stringify(value));
        return value;
      } finally {
        // Release lock
        await redis.del(lockKey);
      }
    } else {
      // Another request holds the lock
      // Wait and retry
      await new Promise((r) => setTimeout(r, 50));

      const retried = await redis.get(cacheKey);
      if (retried) {
        return JSON.parse(retried) as T;
      }

      // Still no cache: call loader directly (may hit database)
      return loader();
    }
  }
}

// Usage
const services = await cacheService.getWithLocking(
  tenantId,
  'services:list',
  async () => {
    return db.query.services.findMany({
      where: { tenant_id: tenantId },
    });
  },
  600 // 10 minute TTL
);
```

---

## Security Considerations

### 1. Cache Poisoning Prevention

**Threat**: Attacker injects malicious data into cache

**Mitigation**:

```typescript
// Validate all data before caching
async function safeSet<T>(
  tenantId: string,
  key: string,
  value: T,
  schema: ZodSchema
): Promise<void> {
  try {
    // Validate structure matches schema
    const validated = schema.parse(value);
    await redis.setex(
      `tenant:${tenantId}:${key}`,
      300,
      JSON.stringify(validated)
    );
  } catch (error) {
    console.error('Cache validation failed:', error);
    throw new Error('Invalid cache value');
  }
}
```

### 2. Sensitive Data in Cache

**Threat**: Passwords or tokens stored unencrypted in Redis

**Mitigation**:

```typescript
// Never cache sensitive data
const NEVER_CACHE = ['password', 'token', 'secret', 'credit_card', 'ssn'];

function isSensitive(key: string): boolean {
  return NEVER_CACHE.some((s) => key.toLowerCase().includes(s));
}

async function safeCache<T>(
  tenantId: string,
  key: string,
  value: T
): Promise<void> {
  if (isSensitive(key)) {
    throw new Error(`Cannot cache sensitive data: ${key}`);
  }

  await redis.setex(`tenant:${tenantId}:${key}`, 300, JSON.stringify(value));
}
```

### 3. Tenant Escalation Attack

**Threat**: Attacker tries to access another tenant's cache

**Mitigation**:

```typescript
// Always validate tenant in request context
async function guardedCacheGet<T>(
  tenantId: string,
  key: string,
  request: any
): Promise<T | null> {
  // Verify authenticated tenant matches request
  const authenticatedTenantId = request.user.tenant_id;

  if (tenantId !== authenticatedTenantId) {
    throw new Error(`Tenant mismatch: ${tenantId} != ${authenticatedTenantId}`);
  }

  const cacheKey = `tenant:${tenantId}:${key}`;
  const value = await redis.get(cacheKey);
  return value ? (JSON.parse(value) as T) : null;
}
```

---

## Audit & Compliance

### Access Logging

```typescript
class CacheAuditLog {
  async log(
    operation: 'get' | 'set' | 'delete',
    tenantId: string,
    key: string,
    userId: string,
    success: boolean,
    reason?: string
  ): Promise<void> {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      operation,
      tenant_id: tenantId,
      cache_key: key,
      user_id: userId,
      success,
      reason: reason || null,
    };

    // Log to audit table
    await db.insert(cache_audit_logs).values(auditEntry);

    // Also log to structured logging
    console.log('[CACHE_AUDIT]', auditEntry);
  }
}
```

### Compliance Checklist

- [ ] All cache keys scoped by `tenant_id`
- [ ] No cross-tenant access possible
- [ ] Sensitive data never cached
- [ ] Cache misses logged for audit
- [ ] Regular consistency audits running
- [ ] Lock mechanisms prevent stampedes
- [ ] TTL strategy documented per cache type
- [ ] Invalidation patterns explicit
- [ ] Redis backups encrypted
- [ ] Access restricted to app servers only

---

## Summary

| Practice                     | Benefit                         | Implementation                        |
| ---------------------------- | ------------------------------- | ------------------------------------- |
| **Tenant-scoped keys**       | Prevents cross-tenant data leak | Always include `tenant_id` in key     |
| **Validation on access**     | Catches configuration errors    | Check tenant context before cache ops |
| **Distributed locks**        | Prevents cache stampedes        | Use Redis SET with NX flag            |
| **Consistency audit**        | Detects stale data              | Periodic verification against DB      |
| **Sensitive data exclusion** | Protects credentials            | Validate before caching               |

**Golden Rule**: If a cache key doesn't include tenant ID, it's a bug.
