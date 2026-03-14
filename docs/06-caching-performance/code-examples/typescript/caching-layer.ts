/**
 * Caching Layer: Redis Wrapper with Tenant Namespacing
 *
 * Production-ready caching service that:
 * - Automatically scopes cache keys by tenant_id
 * - Handles Redis connection failures gracefully
 * - Implements distributed locking
 * - Provides type-safe caching
 *
 * Usage:
 *   const cache = new TenantCacheService(redis, tenantId);
 *   await cache.set('services:list', services, 300);
 *   const cached = await cache.get<Service[]>('services:list');
 */

import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';

export interface CacheOptions {
  ttlSeconds?: number;
  namespace?: string;
  compress?: boolean;
}

export interface DistributedLock {
  key: string;
  token: string;
}

export class LockAcquisitionError extends Error {
  constructor(lockKey: string) {
    super(`Failed to acquire lock: ${lockKey}`);
    this.name = 'LockAcquisitionError';
  }
}

/**
 * Tenant-aware cache service with Redis backend
 */
export class TenantCacheService {
  private readonly keyPrefix: string = 'donebyme';
  private readonly lockPrefix: string = 'lock';
  private readonly releaseLockScript =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

  constructor(
    private readonly redis: Redis,
    private readonly tenantId: string
  ) {}

  /**
   * Generate tenant-scoped cache key
   */
  private getTenantKey(key: string): string {
    return `${this.keyPrefix}:tenant:${this.tenantId}:${key}`;
  }

  /**
   * Generate lock key for distributed locking
   */
  private getLockKey(key: string): string {
    return `${this.keyPrefix}:tenant:${this.tenantId}:${this.lockPrefix}:${key}`;
  }

  /**
   * Get cached value
   * Returns null if key doesn't exist
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const fullKey = this.getTenantKey(key);
      const value = await this.redis.get(fullKey);

      if (!value) {
        return null;
      }

      try {
        return JSON.parse(value) as T;
      } catch (error) {
        // Log but don't throw - cache corruption is transparent
        console.error(`Failed to parse cached value for ${fullKey}:`, error);
        return null;
      }
    } catch (error) {
      // Redis errors should not crash the application
      console.error(`Cache GET error for ${key}:`, error);
      return null; // Fall back to null, caller will fetch from DB
    }
  }

  /**
   * Set cached value with TTL
   */
  async set<T>(key: string, value: T, ttlSeconds: number = 300): Promise<void> {
    try {
      const fullKey = this.getTenantKey(key);
      const serialized = JSON.stringify(value);

      if (ttlSeconds > 0) {
        await this.redis.setex(fullKey, ttlSeconds, serialized);
      } else {
        // No TTL: store permanently (rare, use with caution)
        await this.redis.set(fullKey, serialized);
      }
    } catch (error) {
      // Redis errors should not crash the application
      console.error(`Cache SET error for ${key}:`, error);
      // Silently fail - caching is optimization, not critical
    }
  }

  /**
   * Delete cache entry
   */
  async delete(key: string): Promise<void> {
    try {
      const fullKey = this.getTenantKey(key);
      await this.redis.del(fullKey);
    } catch (error) {
      console.error(`Cache DELETE error for ${key}:`, error);
    }
  }

  /**
   * Invalidate all cache for this tenant
   * Use with caution - use specific key patterns when possible
   */
  async invalidateAll(): Promise<number> {
    try {
      const pattern = `${this.keyPrefix}:tenant:${this.tenantId}:*`;
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
    } catch (error) {
      console.error(`Cache INVALIDATE_ALL error:`, error);
      return 0;
    }
  }

  /**
   * Invalidate cache entries matching a pattern
   * Example: invalidatePattern('services:*') deletes all service cache
   */
  async invalidatePattern(pattern: string): Promise<number> {
    try {
      const fullPattern = this.getTenantKey(pattern);
      const keys = await this.redis.keys(fullPattern);

      if (keys.length === 0) return 0;

      const deletedCount = await this.redis.del(...keys);
      return deletedCount;
    } catch (error) {
      console.error(`Cache INVALIDATE_PATTERN error for ${pattern}:`, error);
      return 0;
    }
  }

  /**
   * Acquire distributed lock
   * Prevents cache stampede when multiple requests miss cache simultaneously
   */
  async acquireLock(
    key: string,
    ttlMs: number = 5000,
    options?: { maxRetries?: number; retryDelayMs?: number }
  ): Promise<DistributedLock> {
    const lockKey = this.getLockKey(key);
    const token = randomUUID();
    const maxRetries = options?.maxRetries ?? 3;
    const retryDelayMs = options?.retryDelayMs ?? 50;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const acquired = await this.redis.set(
          lockKey,
          token,
          'PX',
          ttlMs,
          'NX'
        );

        if (acquired === 'OK') {
          console.debug(`Lock acquired for ${key}`);
          return { key: lockKey, token };
        }
      } catch (error) {
        console.error(`Failed to acquire lock for ${key}:`, error);
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    throw new LockAcquisitionError(lockKey);
  }

  /**
   * Release distributed lock
   * Must be called with the token from acquireLock()
   */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const lockKey = this.getLockKey(key);

    try {
      const result = await this.redis.eval(
        this.releaseLockScript,
        1,
        lockKey,
        token
      );

      const released = Number(result) === 1;

      if (!released) {
        console.debug(`Lock was not held or already released: ${lockKey}`);
      }

      return released;
    } catch (error) {
      console.error(`Failed to release lock for ${key}:`, error);
      return false;
    }
  }

  /**
   * Get or load value with automatic locking to prevent cache stampede
   *
   * Example:
   *   const services = await cache.getOrLoad<Service[]>(
   *     'services:list',
   *     async () => db.query.services.findMany({ where: { tenant_id: tenantId } }),
   *     600
   *   );
   */
  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T>,
    ttlSeconds: number = 300
  ): Promise<T> {
    // Try to get from cache first
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Try to acquire lock
    let lock: DistributedLock | null = null;

    try {
      lock = await this.acquireLock(key, 5000);
    } catch (error) {
      // Lock acquisition failed - another request is loading
      // Wait a bit then try cache again
      await new Promise((resolve) => setTimeout(resolve, 50));
      const retried = await this.get<T>(key);
      if (retried !== null) {
        return retried;
      }
      // Still no cache: load directly (may hit database)
      return loader();
    }

    // We have the lock: load from source
    try {
      const value = await loader();
      await this.set(key, value, ttlSeconds);
      return value;
    } finally {
      // Always release lock
      if (lock) {
        await this.releaseLock(key, lock.token);
      }
    }
  }

  /**
   * Check cache hit ratio (for monitoring)
   */
  async getStats(): Promise<{
    size: number;
    keys: number;
  }> {
    try {
      const pattern = `${this.keyPrefix}:tenant:${this.tenantId}:*`;
      const keys = await this.redis.keys(pattern);

      let size = 0;
      for (const key of keys) {
        const bytes = await this.redis.strlen(key);
        size += bytes;
      }

      return {
        keys: keys.length,
        size, // bytes
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return { keys: 0, size: 0 };
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch (error) {
      console.error('Cache health check failed:', error);
      return false;
    }
  }
}

/**
 * Example: Using TenantCacheService with different data types
 */
export async function cacheLayerExamples(
  redis: Redis,
  tenantId: string
): Promise<void> {
  const cache = new TenantCacheService(redis, tenantId);

  // Example 1: Simple cache get/set
  interface Service {
    id: string;
    name: string;
  }

  const services: Service[] = [
    { id: '1', name: 'Hair Cut' },
    { id: '2', name: 'Hair Coloring' },
  ];

  await cache.set('services:list', services, 600);
  const cachedServices = await cache.get<Service[]>('services:list');
  console.log('Cached services:', cachedServices);

  // Example 2: Cache with auto-loading (prevents N+1)
  const getServices = async () => {
    console.log('Loading services from database...');
    return services; // Simulating DB query
  };

  const result = await cache.getOrLoad<Service[]>(
    'services:full',
    getServices,
    600
  );
  console.log('Services via getOrLoad:', result);

  // Example 3: Pattern-based invalidation
  await cache.set('availability:staff:1', { available: true }, 300);
  await cache.set('availability:staff:2', { available: false }, 300);
  const invalidated = await cache.invalidatePattern('availability:*');
  console.log(`Invalidated ${invalidated} cache entries`);

  // Example 4: Distributed locking
  try {
    const lock = await cache.acquireLock('booking:create', 5000);
    try {
      console.log('Lock acquired, performing operation...');
      // Simulate operation
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      const released = await cache.releaseLock('booking:create', lock.token);
      console.log(`Lock released: ${released}`);
    }
  } catch (error) {
    console.error('Failed to acquire lock:', error);
  }

  // Example 5: Cache stats
  const stats = await cache.getStats();
  console.log('Cache stats:', stats);
}
