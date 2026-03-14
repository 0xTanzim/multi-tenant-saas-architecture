/**
 * Per-Tenant Rate Limiting Implementation
 *
 * This module demonstrates how to implement per-tenant rate limiting using:
 * 1. Token Bucket algorithm for burst allowance
 * 2. Redis for fast, distributed state
 * 3. Quota tracking per month
 * 4. Graceful degradation under load
 *
 * Key features:
 * - Per-tenant limits based on subscription plan
 * - Per-user limits within tenant
 * - Per-endpoint limits for expensive operations
 * - Monthly quota tracking
 * - Retry-After header guidance
 */

import {
  Injectable,
  Logger,
  NestMiddleware,
  TooManyRequestsException,
} from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import Redis from 'ioredis';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface RateLimitConfig {
  limit: number; // Requests per window
  window: number; // Window size in seconds
  burst?: number; // Burst capacity (optional)
}

export interface SubscriptionPlanLimits {
  free: RateLimitConfig;
  starter: RateLimitConfig;
  professional: RateLimitConfig;
  enterprise: RateLimitConfig;
}

export interface QuotaConfig {
  quotaType: 'api_calls' | 'storage' | 'bulk_operations';
  unit: 'requests' | 'mb' | 'operations';
  resetPeriod: 'monthly' | 'daily' | 'hourly';
}

export interface RateLimitState {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResponse {
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp
  retryAfter?: number; // Seconds
}

// ============================================================================
// Rate Limiting Service (Token Bucket Algorithm)
// ============================================================================

@Injectable()
export class RateLimitingService {
  private readonly logger = new Logger(RateLimitingService.name);
  private readonly redis: Redis;

  // Per-subscription-plan rate limits (requests per minute)
  private readonly planLimits: SubscriptionPlanLimits = {
    free: {
      limit: 50,
      window: 60,
      burst: 100,
    },
    starter: {
      limit: 500,
      window: 60,
      burst: 1000,
    },
    professional: {
      limit: 5000,
      window: 60,
      burst: 10000,
    },
    enterprise: {
      limit: 50000,
      window: 60,
      burst: 100000,
    },
  };

  // Per-user limits within tenant
  private readonly perUserLimit: RateLimitConfig = {
    limit: 100,
    window: 60,
  };

  // Per-endpoint limits
  private readonly endpointLimits: Record<string, RateLimitConfig> = {
    'POST /api/bookings': { limit: 10, window: 60 },
    'POST /api/payments': { limit: 5, window: 60 },
    'POST /api/bulk-import': { limit: 1, window: 60 },
    'GET /api/analytics': { limit: 5, window: 60 },
  };

  constructor(redisClient?: Redis) {
    this.redis =
      redisClient ||
      new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      });
  }

  /**
   * Check if request should be rate limited
   */
  async checkRateLimit(
    tenantId: number,
    userId: string,
    plan: 'free' | 'starter' | 'professional' | 'enterprise',
    endpoint?: string
  ): Promise<RateLimitResponse> {
    const limitsToCheck = [
      {
        key: `rate:tenant:${tenantId}`,
        config: this.planLimits[plan],
        type: 'tenant',
      },
      { key: `rate:user:${userId}`, config: this.perUserLimit, type: 'user' },
      ...(endpoint
        ? [
            {
              key: `rate:endpoint:${endpoint}`,
              config: this.endpointLimits[endpoint],
              type: 'endpoint',
            },
          ]
        : []),
    ];

    let mostRestrictiveLimit = limitsToCheck[0];

    for (const limitCheck of limitsToCheck) {
      if (!limitCheck.config) continue;

      const result = await this.checkTokenBucket(
        limitCheck.key,
        limitCheck.config
      );

      if (result.remaining === 0) {
        this.logger.warn(
          `Rate limit exceeded: ${limitCheck.type} (key: ${limitCheck.key})`,
          { tenantId, userId, endpoint }
        );
        throw new TooManyRequestsException({
          code: 'RATE_LIMIT_EXCEEDED',
          message: `${limitCheck.type
            .charAt(0)
            .toUpperCase()}${limitCheck.type.slice(1)} rate limit exceeded`,
          details: {
            type: limitCheck.type,
            limit: result.limit,
            retryAfter: result.retryAfter,
          },
        });
      }

      // Track the most restrictive limit
      if (result.remaining < mostRestrictiveLimit.remaining) {
        mostRestrictiveLimit = result;
      }
    }

    return mostRestrictiveLimit;
  }

  /**
   * Token Bucket Algorithm Implementation
   *
   * @param key Redis key for this bucket
   * @param config Rate limit configuration
   * @returns Current rate limit status
   */
  private async checkTokenBucket(
    key: string,
    config: RateLimitConfig
  ): Promise<RateLimitResponse> {
    const now = Date.now();
    const windowSeconds = config.window;
    const maxTokens = config.limit;
    const refillRate = maxTokens / (windowSeconds * 1000); // tokens per millisecond

    // Get current bucket state
    const bucketJson = await this.redis.get(key);
    let bucket: RateLimitState = bucketJson
      ? JSON.parse(bucketJson)
      : { tokens: maxTokens, lastRefill: now };

    // Calculate elapsed time since last refill
    const elapsedMs = now - bucket.lastRefill;

    // Refill tokens
    const tokensToAdd = elapsedMs * refillRate;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + tokensToAdd);

    // Check if we have tokens to consume
    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillRate / 1000);
      const resetTime = Math.floor(now / 1000) + retryAfter;

      return {
        limit: maxTokens,
        remaining: 0,
        reset: resetTime,
        retryAfter,
      };
    }

    // Consume one token
    bucket.tokens -= 1;
    bucket.lastRefill = now;

    // Save updated state (with TTL)
    await this.redis.setex(
      key,
      windowSeconds + 10, // Extra 10s buffer
      JSON.stringify(bucket)
    );

    const resetTime = Math.floor(now / 1000) + windowSeconds;

    return {
      limit: maxTokens,
      remaining: Math.floor(bucket.tokens),
      reset: resetTime,
    };
  }

  /**
   * Check monthly quota
   */
  async checkMonthlyQuota(
    tenantId: number,
    quotaType: 'api_calls' | 'storage' | 'bulk_operations',
    plan: string
  ): Promise<{ remaining: number; limit: number; resetDate: Date }> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const key = `quota:${tenantId}:${quotaType}:${monthStart.toISOString()}`;

    // Get current usage
    const current = parseInt((await this.redis.get(key)) || '0', 10);

    // Get plan limit
    const limits: Record<string, Record<string, number>> = {
      api_calls: {
        free: 10000,
        starter: 100000,
        professional: 1000000,
        enterprise: -1,
      },
      storage: {
        free: 500,
        starter: 5000,
        professional: 50000,
        enterprise: -1,
      },
      bulk_operations: {
        free: 100,
        starter: 1000,
        professional: 10000,
        enterprise: -1,
      },
    };

    const limit = limits[quotaType][plan] || limits[quotaType].free;

    // Check if exceeded (unless enterprise)
    if (limit > 0 && current >= limit) {
      throw new TooManyRequestsException({
        code: 'QUOTA_EXCEEDED',
        message: `Monthly ${quotaType} quota exceeded`,
        details: {
          quotaType,
          limit,
          current,
          resetDate: new Date(
            now.getFullYear(),
            now.getMonth() + 1,
            1
          ).toISOString(),
        },
      });
    }

    const remaining = limit > 0 ? limit - current : -1; // -1 for unlimited

    // Calculate next month reset
    const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    return { remaining, limit, resetDate };
  }

  /**
   * Increment quota counter
   */
  async incrementQuota(
    tenantId: number,
    quotaType: 'api_calls' | 'storage' | 'bulk_operations',
    amount: number = 1
  ): Promise<number> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const key = `quota:${tenantId}:${quotaType}:${monthStart.toISOString()}`;

    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const secondsUntilReset = Math.floor(
      (monthEnd.getTime() - now.getTime()) / 1000
    );

    // Increment and set expiry
    const count = await this.redis.incrby(key, amount);
    await this.redis.expire(key, secondsUntilReset + 86400); // +1 day buffer

    return count;
  }

  /**
   * Reset rate limit for testing
   */
  async resetRateLimit(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

// ============================================================================
// Rate Limiting Middleware
// ============================================================================

@Injectable()
export class RateLimitingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RateLimitingMiddleware.name);

  constructor(private readonly rateLimitService: RateLimitingService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Skip rate limiting for global routes
      if (this.isGlobalRoute(req.path)) {
        return next();
      }

      // Check if tenant context is available
      if (!req.tenantId || !req.user) {
        return next(); // Skip (guard will handle)
      }

      // Get tenant subscription plan (could be cached)
      const plan = req.user.tenantPlan || 'free';

      // Check rate limit
      const endpoint = `${req.method} ${req.path}`;
      const rateLimitResult = await this.rateLimitService.checkRateLimit(
        req.tenantId,
        req.user.id,
        plan,
        endpoint
      );

      // Increment quota counter
      await this.rateLimitService.incrementQuota(req.tenantId, 'api_calls', 1);

      // Add rate limit headers to response
      res.setHeader('RateLimit-Limit', rateLimitResult.limit);
      res.setHeader('RateLimit-Remaining', rateLimitResult.remaining);
      res.setHeader('RateLimit-Reset', rateLimitResult.reset);

      if (rateLimitResult.retryAfter) {
        res.setHeader('Retry-After', rateLimitResult.retryAfter);
      }

      // Add to response body (optional)
      const originalJson = res.json.bind(res);
      res.json = function (body: any) {
        return originalJson({
          ...body,
          meta: {
            ...(body.meta || {}),
            rateLimit: {
              limit: rateLimitResult.limit,
              remaining: rateLimitResult.remaining,
              reset: rateLimitResult.reset,
            },
          },
        });
      };

      next();
    } catch (error) {
      if (error instanceof TooManyRequestsException) {
        const response = error.getResponse() as any;
        res.setHeader('Retry-After', response.details?.retryAfter || 60);
        return res.status(429).json(response);
      }

      this.logger.error(
        `Rate limiting error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : ''
      );

      next(error);
    }
  }

  private isGlobalRoute(path: string): boolean {
    const globalRoutes = [
      '/api/auth',
      '/api/health',
      '/api/docs',
      '/api/swagger',
    ];

    return globalRoutes.some((route) => path.startsWith(route));
  }
}

// ============================================================================
// Graceful Degradation Service
// ============================================================================

@Injectable()
export class GracefulDegradationService {
  private readonly logger = new Logger(GracefulDegradationService.name);
  private readonly redis: Redis;

  constructor(redisClient?: Redis) {
    this.redis = redisClient || new Redis();
  }

  /**
   * Get current system load level
   */
  async getLoadLevel(): Promise<'normal' | 'elevated' | 'high' | 'critical'> {
    // Metrics (would integrate with Prometheus or similar)
    const metrics = {
      cpu: 50, // Percent
      memory: 60, // Percent
      dbConnections: 40, // Percent
    };

    const avgLoad = (metrics.cpu + metrics.memory + metrics.dbConnections) / 3;

    if (avgLoad < 60) return 'normal';
    if (avgLoad < 80) return 'elevated';
    if (avgLoad < 95) return 'high';
    return 'critical';
  }

  /**
   * Check if request should be allowed under degraded conditions
   */
  async shouldAllow(
    endpoint: string,
    loadLevel: 'normal' | 'elevated' | 'high' | 'critical'
  ): Promise<boolean> {
    const criticalEndpoints = [
      'GET /api/bookings',
      'POST /api/bookings/:id:confirm',
      'GET /api/availability',
    ];

    if (loadLevel === 'critical') {
      // Only allow critical endpoints
      return criticalEndpoints.some((critical) =>
        this.endpointMatches(endpoint, critical)
      );
    }

    if (loadLevel === 'high') {
      // Allow everything except analytics/exports
      return !endpoint.includes('analytics') && !endpoint.includes('export');
    }

    if (loadLevel === 'elevated') {
      // All endpoints allowed but with reduced rate limits
      return true;
    }

    return true; // Normal load, all allowed
  }

  /**
   * Get degraded rate limit
   */
  getDegradedRateLimit(
    originalLimit: number,
    loadLevel: 'normal' | 'elevated' | 'high' | 'critical'
  ): number {
    if (loadLevel === 'normal') return originalLimit;
    if (loadLevel === 'elevated') return Math.ceil(originalLimit * 0.8); // 20% reduction
    if (loadLevel === 'high') return Math.ceil(originalLimit * 0.5); // 50% reduction
    return Math.ceil(originalLimit * 0.2); // 80% reduction for critical
  }

  private endpointMatches(actual: string, pattern: string): boolean {
    const regex = new RegExp(`^${pattern.replace(/:[^\/]+/g, '[^/]+')}$`);
    return regex.test(actual);
  }
}

// ============================================================================
// Usage Example
// ============================================================================

/*
EXAMPLE: Module Setup
---------------------

import { Module } from '@nestjs/common';
import { RateLimitingService } from './rate-limiting.service';
import { RateLimitingMiddleware } from './rate-limiting.middleware';
import { GracefulDegradationService } from './graceful-degradation.service';

@Module({
  providers: [RateLimitingService, GracefulDegradationService],
  exports: [RateLimitingService, GracefulDegradationService]
})
export class RateLimitingModule {}


EXAMPLE: Apply Middleware
--------------------------

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RateLimitingMiddleware } from './middleware/rate-limiting.middleware';

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RateLimitingMiddleware)
      .forRoutes('api/*');
  }
}


EXAMPLE: Check Rate Limit in Service
------------------------------------

async createBooking(tenantId: number, input: CreateBookingDto) {
  // Check rate limit
  const rateLimitResult = await this.rateLimitService.checkRateLimit(
    tenantId,
    currentUser.id,
    tenant.plan,
    'POST /api/bookings'
  );

  // Check quota
  const quota = await this.rateLimitService.checkMonthlyQuota(
    tenantId,
    'api_calls',
    tenant.plan
  );

  // Proceed with business logic
  return await bookingService.create(tenantId, input);
}


EXAMPLE: Graceful Degradation in Controller
--------------------------------------------

@Get()
async getBookings(
  @GetTenantId() tenantId: number,
  @Query() query: GetBookingsDto
) {
  const loadLevel = await this.degradationService.getLoadLevel();

  if (!await this.degradationService.shouldAllow('GET /api/bookings', loadLevel)) {
    throw new ServiceUnavailableException('Service temporarily unavailable');
  }

  return await bookingService.getBookings(tenantId, query);
}
*/
