# Rate Limiting & Quotas for Multi-Tenant SaaS

## Overview

This document defines rate limiting strategies, quota management, throttling mechanisms, and graceful degradation patterns for multi-tenant APIs. These patterns ensure:

1. **Fair resource allocation** across tenants
2. **Abuse prevention** (bot attacks, resource exhaustion)
3. **SLA compliance** (consistent performance)
4. **Transparent quota management** (clients know limits)

---

## Rate Limiting Strategy

### Levels of Rate Limiting

```
┌─────────────────────────────────────────────────────┐
│                   RATE LIMIT LAYERS                  │
├─────────────────────────────────────────────────────┤
│  1. Global (Per IP / User-Agent)                    │
│     → Prevent DDoS attacks                          │
│     → Limit: 1000 requests/minute                   │
│                                                      │
│  2. Per-Tenant                                       │
│     → Allocate quota fairly                         │
│     → Limit: Based on subscription plan             │
│                                                      │
│  3. Per-User (within tenant)                        │
│     → Prevent single user hogging                   │
│     → Limit: 100 requests/minute                    │
│                                                      │
│  4. Per-Endpoint                                     │
│     → Protect expensive operations                  │
│     → Limit: 5-10 concurrent requests               │
└─────────────────────────────────────────────────────┘
```

### Per-Tenant Rate Limiting

Different limits based on subscription plan:

| Plan         | Monthly API Calls | Rate Limit (per minute) | Burst   |
| ------------ | ----------------- | ----------------------- | ------- |
| Free         | 10,000            | 50                      | 100     |
| Starter      | 100,000           | 500                     | 1,000   |
| Professional | 1,000,000         | 5,000                   | 10,000  |
| Enterprise   | Unlimited\*       | 50,000                  | 100,000 |

\*Enterprise has custom limits based on contract

### Per-User Rate Limiting

Each user (within their tenant) gets:

```typescript
// Default limits per user
const perUserLimits = {
  defaultRateLimit: 100, // requests per minute
  burstCapacity: 200, // peak requests per minute
  windowSize: 60, // seconds

  // Endpoint-specific limits
  endpoints: {
    'POST /api/bookings': 10, // Prevent booking spam
    'POST /api/payments': 5, // Prevent payment spam
    'GET /api/analytics': 5, // Prevent analytics abuse
    'POST /api/bulk-import': 1, // One import per minute
  },
};
```

---

## Quota Management

### Quota Types

| Quota Type              | Unit           | Tracking           | Reset              |
| ----------------------- | -------------- | ------------------ | ------------------ |
| **API Calls**           | requests/month | Per-tenant         | Monthly (calendar) |
| **Data Storage**        | MB/month       | Per-tenant DB size | — (cumulative)     |
| **Concurrent Requests** | requests       | Per-tenant         | Real-time          |
| **Bulk Operations**     | operations/day | Per-tenant         | Daily (UTC)        |
| **Export API**          | exports/month  | Per-tenant         | Monthly            |
| **Email Notifications** | sends/month    | Per-tenant         | Monthly            |

### Quota Tracking Implementation

```typescript
async trackAPICall(tenantId: number, endpoint: string) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Increment call counter
  const key = `quota:${tenantId}:api_calls:${monthStart.toISOString()}`;
  const count = await redis.incr(key);

  // Get quota limit
  const tenant = await tenantRepository.findById(tenantId);
  const plan = tenant.subscriptionPlan; // 'free' | 'starter' | 'professional'
  const quotaLimit = getQuotaLimit(plan, 'api_calls');

  // Check if exceeded
  if (count > quotaLimit) {
    throw new TooManyRequestsException({
      code: 'QUOTA_EXCEEDED',
      message: `API call quota exceeded for this month`,
      details: {
        quotaType: 'api_calls',
        limit: quotaLimit,
        current: count,
        resetAt: getNextMonthStart(monthStart).toISOString()
      }
    });
  }

  return { remaining: quotaLimit - count };
}
```

### Quota Reset Window

```typescript
function getQuotaResetTime(quotaType: string): Date {
  const now = new Date();

  switch (quotaType) {
    case 'api_calls':
    case 'email_sends':
    case 'exports':
      // Reset first of next month at 00:00 UTC
      return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);

    case 'bulk_operations':
      // Reset next day at 00:00 UTC
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      return tomorrow;

    case 'concurrent_requests':
      // Always "current", no reset
      return null;

    default:
      return null;
  }
}
```

---

## Throttling Strategy

### Token Bucket Algorithm

Classic, efficient rate limiting algorithm:

```typescript
async checkRateLimit(tenantId: number, limit: number, window: number) {
  const key = `rate_limit:${tenantId}`;

  // Get current bucket state
  const bucket = await redis.get(key);
  let tokens = bucket ? JSON.parse(bucket) : limit;

  // Calculate time elapsed since last request
  const now = Date.now();
  const lastRefill = bucket?.lastRefill || now;
  const elapsedMs = now - lastRefill;

  // Refill tokens (rate = limit tokens per window)
  const refillRate = limit / (window * 1000); // tokens per ms
  const tokensToAdd = elapsedMs * refillRate;
  tokens = Math.min(limit, tokens + tokensToAdd);

  // Check if we have tokens
  if (tokens < 1) {
    throw new TooManyRequestsException({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded',
      retryAfter: Math.ceil((1 - tokens) / refillRate / 1000)
    });
  }

  // Consume token
  tokens -= 1;

  // Save updated bucket
  await redis.set(
    key,
    JSON.stringify({ tokens, lastRefill: now }),
    'EX',
    window
  );

  return { remaining: Math.floor(tokens) };
}
```

### Sliding Window Log Algorithm

For precise rate limiting (less efficient but accurate):

```typescript
async checkRateLimitSlidingWindow(
  tenantId: number,
  limit: number,
  window: number
) {
  const key = `rate_limit:${tenantId}:log`;
  const now = Date.now();
  const windowStart = now - window * 1000;

  // Remove old entries outside window
  await redis.zremrangebyscore(key, 0, windowStart);

  // Count current requests in window
  const requestCount = await redis.zcard(key);

  if (requestCount >= limit) {
    const oldestRequest = await redis.zrange(key, 0, 0, 'WITHSCORES');
    const retryAfter = Math.ceil(
      (oldestRequest[1] + window * 1000 - now) / 1000
    );

    throw new TooManyRequestsException({
      code: 'RATE_LIMIT_EXCEEDED',
      message: `Rate limit of ${limit} requests per ${window}s exceeded`,
      retryAfter
    });
  }

  // Add current request
  await redis.zadd(key, now, `${tenantId}:${now}`);
  await redis.expire(key, window);

  return { remaining: limit - requestCount - 1 };
}
```

---

## Response Headers for Rate Limiting

All responses include rate limit headers:

```
HTTP/1.1 200 OK
RateLimit-Limit: 100
RateLimit-Remaining: 42
RateLimit-Reset: 1620003600
X-RateLimit-Limit-Month: 100000
X-RateLimit-Used-Month: 45000
X-RateLimit-Remaining-Month: 55000
X-RateLimit-Reset-Month: 2025-06-01T00:00:00Z
Retry-After: 30

{
  "data": { /* response */ },
  "meta": {
    "rateLimit": {
      "limit": 100,
      "remaining": 42,
      "resetAt": "2025-05-10T14:31:00Z"
    }
  }
}
```

### Header Explanation

| Header                        | Purpose                 | Format             |
| ----------------------------- | ----------------------- | ------------------ |
| `RateLimit-Limit`             | Requests per minute     | `<number>`         |
| `RateLimit-Remaining`         | Requests left in window | `<number>`         |
| `RateLimit-Reset`             | Unix timestamp of reset | `<unix_timestamp>` |
| `X-RateLimit-Limit-Month`     | Monthly quota           | `<number>`         |
| `X-RateLimit-Used-Month`      | Monthly usage           | `<number>`         |
| `X-RateLimit-Remaining-Month` | Monthly remaining       | `<number>`         |
| `X-RateLimit-Reset-Month`     | Monthly reset time      | ISO 8601           |
| `Retry-After`                 | Seconds to retry        | `<number>`         |

---

## 429 Too Many Requests Response

```typescript
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "You have exceeded the rate limit",
    "details": {
      "type": "per_minute",        // or "per_month", "concurrent"
      "limit": 100,
      "window": 60,                 // seconds
      "current": 101,
      "resetAt": "2025-05-10T14:31:00Z"
    },
    "retryAfter": 30                // seconds to retry
  }
}
```

---

## Gradual Degradation Under Load

### Load Levels

```
┌──────────────────────────────────────────────────────────┐
│           API LOAD DEGRADATION STRATEGY                   │
├──────────────────────────────────────────────────────────┤
│  Level 1: Normal (0-60% capacity)                        │
│  → All endpoints available                               │
│  → Full rate limits enforced                             │
│  → Latency: < 200ms p99                                  │
│                                                           │
│  Level 2: Elevated (60-80% capacity)                     │
│  → Non-essential endpoints (analytics, exports) limited  │
│  → Rate limits reduced by 20%                            │
│  → Priority: bookings, payments                          │
│  → Latency: < 500ms p99                                  │
│                                                           │
│  Level 3: High (80-95% capacity)                         │
│  → Only critical endpoints available:                    │
│    - GET bookings                                         │
│    - POST bookings (confirm/cancel)                      │
│    - GET availability                                     │
│  → Rate limits reduced by 50%                            │
│  → Read replicas prioritized                             │
│  → Latency: < 1s p99                                     │
│                                                           │
│  Level 4: Critical (> 95% capacity)                      │
│  → Queue-based request handling                          │
│  → Only GET endpoints                                    │
│  → Background jobs paused                                │
│  → Circuit breaker activated                             │
│  → Return 503 Service Unavailable for non-critical       │
│  → Latency: < 5s p99                                     │
└──────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
async checkSystemLoad(): Promise<LoadLevel> {
  const metrics = await getMetrics();

  const cpuUsage = metrics.cpu / 100;
  const memUsage = metrics.memory / metrics.memoryLimit;
  const dbConnections = metrics.activeConnections / metrics.maxConnections;

  // Calculate overall capacity
  const avgUsage = (cpuUsage + memUsage + dbConnections) / 3;

  if (avgUsage < 0.6) return 'normal';
  if (avgUsage < 0.8) return 'elevated';
  if (avgUsage < 0.95) return 'high';
  return 'critical';
}

async handleRequest(req: Request, res: Response, next: NextFunction) {
  const loadLevel = await checkSystemLoad();

  if (loadLevel === 'critical') {
    // Only allow critical reads
    if (!isCriticalEndpoint(req)) {
      return res.status(503).json({
        error: {
          code: 'SERVICE_DEGRADED',
          message: 'Service temporarily unavailable due to high load'
        }
      });
    }
  }

  if (loadLevel === 'high') {
    // Reduce rate limits
    req.rateLimit = Math.ceil(req.rateLimit * 0.5);
  }

  next();
}
```

---

## Priority Queue for Degradation

Under critical load, queue requests by priority:

```typescript
class RequestQueue {
  private queues = {
    critical: [], // Bookings, payments
    high: [], // Dashboard, history
    normal: [], // Analytics, exports
  };

  async enqueue(request: Request, priority: 'critical' | 'high' | 'normal') {
    const queue = this.queues[priority];

    // Check max wait time
    if (queue.length > 100 && priority === 'normal') {
      throw new ServiceUnavailableException({
        code: 'QUEUE_FULL',
        message: 'Request queue is full. Please retry later.',
      });
    }

    return new Promise((resolve, reject) => {
      queue.push({ request, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    // Process critical first, then high, then normal
    for (const priority of ['critical', 'high', 'normal']) {
      const queue = this.queues[priority];

      while (queue.length > 0 && this.canProcess()) {
        const { request, resolve, reject } = queue.shift();
        try {
          const result = await this.executeRequest(request);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }
    }
  }

  private canProcess(): boolean {
    // Check if we have capacity
    return this.getSystemLoad() < 0.9;
  }
}
```

---

## Retry Strategy for Clients

### Exponential Backoff

```typescript
async function retryWithBackoff(
  request: () => Promise<any>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await request();
    } catch (error) {
      // Check if retriable
      if (!isRetriable(error)) throw error;

      // Last attempt
      if (attempt === maxRetries) throw error;

      // Calculate delay with jitter
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      const jitterMs = Math.random() * 1000;
      const totalDelayMs = delayMs + jitterMs;

      console.log(`Retry ${attempt + 1}/${maxRetries} after ${totalDelayMs}ms`);
      await delay(totalDelayMs);
    }
  }
}

function isRetriable(error: any): boolean {
  // Retriable errors
  return (
    error.status === 429 || // Too Many Requests
    error.status === 503 || // Service Unavailable
    error.status === 504 || // Gateway Timeout
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT'
  );
}
```

### Using Retry-After Header

```typescript
async function retryAfter(response: Response) {
  const retryAfter = response.headers.get('Retry-After');

  if (!retryAfter) {
    // Default exponential backoff
    return Math.pow(2, attempt) * 1000;
  }

  // Parse Retry-After (can be seconds or date)
  if (/^\d+$/.test(retryAfter)) {
    // Seconds
    return parseInt(retryAfter) * 1000;
  } else {
    // HTTP date
    const retryDate = new Date(retryAfter);
    return retryDate.getTime() - Date.now();
  }
}
```

---

## Quota Alerts & Warnings

### Usage Threshold Alerts

Send notifications when quota usage reaches thresholds:

```
80% → Email warning
95% → Email + SMS alert
100% → Hard block, suggest upgrade
```

```typescript
async monitorQuotaUsage(tenantId: number) {
  const tenant = await tenantRepository.findById(tenantId);
  const usage = await getMonthlyUsage(tenantId);
  const quota = getQuotaLimit(tenant.plan, 'api_calls');

  const usagePercent = (usage / quota) * 100;

  if (usagePercent === 80) {
    await notificationService.sendEmail({
      to: tenant.billingEmail,
      subject: 'API Usage Warning (80%)',
      body: `You have used 80% of your monthly API quota (${usage}/${quota})`
    });
  }

  if (usagePercent === 95) {
    await notificationService.sendSMS({
      to: tenant.billingPhone,
      body: `API quota almost full (95%). Upgrade or reset on ${resetDate}`
    });
  }

  if (usagePercent >= 100) {
    // Hard block
    await tenantRepository.update(tenantId, {
      quotaExceededAt: new Date(),
      status: 'quota_exceeded'
    });
  }
}
```

---

## Best Practices

| Practice                   | Why                         | Example                         |
| -------------------------- | --------------------------- | ------------------------------- |
| Tenant-scoped limits       | Fair allocation             | Per-plan rate limits            |
| Token bucket algorithm     | Efficient, forgiving bursts | 100 req/min + 200 burst         |
| Include rate limit headers | Transparency                | `RateLimit-Remaining`           |
| Graceful degradation       | Keep critical ops working   | Queue non-essential requests    |
| Priority queuing           | Fair resource distribution  | Critical > High > Normal        |
| Monthly quotas             | Predictable costs           | API calls, storage, email       |
| Retry headers              | Client guidance             | `Retry-After: 30`               |
| Quota alerts               | Proactive communication     | 80% warning, 95% alert          |
| Soft limits first          | User experience             | Warn at 90%, hard block at 100% |

---

## References

- [Rate Limiting Strategies](https://en.wikipedia.org/wiki/Token_bucket)
- [HTTP Status 429](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429)
- [AWS API Gateway Rate Limiting](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)
- [Stripe Rate Limiting](https://stripe.com/docs/rate-limits)
