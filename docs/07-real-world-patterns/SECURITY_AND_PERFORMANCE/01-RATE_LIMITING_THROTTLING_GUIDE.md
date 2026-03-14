> **Source**: Extracted from production system, sanitized for portfolio use
> **Original**: DoneByMe @nestjs/throttler Complete Guide
> **Status**: Production Implementation

# API Rate Limiting & Throttling — Complete Implementation Guide

**Package**: @nestjs/throttler v6+
**Status**: Production-Ready
**Purpose**: Prevent API abuse, ensure fair resource allocation

---

## 1. Core Concepts

### IP-Based vs User-Based Rate Limiting

| Approach         | Use Case                           | Tracking            |
| ---------------- | ---------------------------------- | ------------------- |
| **IP-Based**     | Public endpoints (login, register) | Client IP address   |
| **User-Based**   | Authenticated endpoints (bookings) | User ID from JWT    |
| **Tenant-Based** | Multi-tenant endpoints             | Tenant ID + User ID |

**Default Behavior**: IP-based
**For Fair Allocation**: User-based (each user gets independent limit)

---

## 2. Three-Level Rate Limiting Architecture

```
┌─────────────────────────────────────────┐
│  Public Endpoints (IP-Based)            │
│  POST /auth/login — 10/min per IP       │
│  POST /auth/register — 5/min per IP     │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Authenticated Endpoints (User-Based)   │
│  POST /bookings — 5/min per user        │
│  GET /availability — 20/min per user    │
│  DELETE /bookings/:id — 10/min per user │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Admin Endpoints (Role-Based)           │
│  POST /reports/export — 50/min per admin│
│  GET /analytics — 100/min per admin     │
└─────────────────────────────────────────┘
```

---

## 3. Module Configuration

### Step 1: Setup Throttler Module

**File**: `apps/api/src/app.module.ts`

```typescript
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'short', // Burst protection
        ttl: 1000, // 1 second
        limit: 3, // 3 requests/sec
      },
      {
        name: 'medium', // Normal usage
        ttl: 60000, // 1 minute
        limit: 20, // 20 requests/min
      },
      {
        name: 'long', // Hourly limits
        ttl: 3600000, // 1 hour
        limit: 1000, // 1000 requests/hour
      },
    ]),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
```

**How Multiple Limits Work**:
Request must pass ALL limits (short AND medium AND long). If ANY limit exceeded → 429 Too Many Requests.

---

## 4. Custom User-Based Guard

### Step 2: Implement User-Aware Throttling

**File**: `apps/api/src/common/guards/user-throttler.guard.ts`

```typescript
import { ThrottlerGuard } from '@nestjs/throttler';
import { Injectable, ExecutionContext } from '@nestjs/common';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  /**
   * Generate tracking key based on user ID instead of IP
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Check if user is authenticated (from JWT)
    const user = req.user;

    if (user && user.id) {
      // ✅ User-based tracking
      return `user:${user.id}`;
    }

    // ❌ Fallback to IP for unauthenticated
    return req.ip;
  }

  protected throwThrottlingException(context: ExecutionContext): void {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    throw new Error(
      user
        ? `Rate limit exceeded for user ${user.id}. Please try again later.`
        : 'Rate limit exceeded. Please try again later.'
    );
  }
}
```

---

## 5. Tenant-Aware Throttling

### For Multi-Tenant Systems

**File**: `apps/api/src/common/guards/tenant-throttler.guard.ts`

```typescript
import { ThrottlerGuard } from '@nestjs/throttler';
import { Injectable } from '@nestjs/common';

@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  /**
   * Generate tracking key: tenant + user
   * Each user gets separate limits per tenant
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const user = req.user;
    const tenant = req.tenant; // From TenantMiddleware

    if (tenant && user) {
      // ✅ Tenant + User tracking
      return `tenant:${tenant.id}:user:${user.id}`;
    }

    if (user) {
      // ✅ User tracking only
      return `user:${user.id}`;
    }

    // ❌ Fallback to IP
    return req.ip;
  }
}
```

**Tracking Keys Generated**:

```
Unauthenticated: throttle:192.168.1.1:POST:/auth/login
Authenticated: throttle:user:123:POST:/bookings
Tenant Context: throttle:tenant:1:user:123:POST:/bookings
```

---

## 6. Applying Rate Limits to Controllers

### Public Endpoints (IP-Based)

```typescript
@Controller('auth')
export class AuthController {
  @Post('login')
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  // 5 login attempts per minute per IP
  async login(@Body() dto: LoginDto) {}

  @Post('register')
  @Throttle({ short: { limit: 3, ttl: 60000 } })
  // 3 registrations per minute per IP
  async register(@Body() dto: RegisterDto) {}

  @Get('verify-email/:token')
  @SkipThrottle()
  // Email verification link shouldn't be rate limited
  async verifyEmail(@Param('token') token: string) {}
}
```

### Authenticated Endpoints (User-Based)

```typescript
@Controller(':tenantSlug/bookings')
@UseGuards(UserThrottlerGuard)
export class BookingController {
  @Post()
  @Throttle({ medium: { limit: 5, ttl: 60000 } })
  // 5 bookings per minute PER USER
  async createBooking(@Body() dto: CreateBookingDto, @Request() req) {}

  @Get('availability')
  @Throttle({ medium: { limit: 20, ttl: 60000 } })
  // 20 availability checks per minute
  async checkAvailability(@Query() query: AvailabilityQueryDto) {}

  @Delete(':id')
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  // 10 cancellations per minute
  async cancelBooking(@Param('id') id: number) {}
}
```

### Admin Endpoints (Role-Based)

```typescript
@Controller(':tenantSlug/admin')
@UseGuards(JwtAuthGuard, RoleGuard, UserThrottlerGuard)
@Roles('admin')
export class AdminController {
  @Post('reports/export')
  @Throttle({ medium: { limit: 50, ttl: 60000 } })
  // Admins get higher limit: 50/min vs 5/min for users
  async exportReport(@Body() dto: ExportReportDto) {}
}
```

---

## 7. Rate Limit Response Headers

Throttler automatically adds HTTP headers:

```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 5           # Max requests allowed
X-RateLimit-Remaining: 3       # Requests remaining
X-RateLimit-Reset: 1697234567  # Unix timestamp when limit resets
Retry-After: 45                # Seconds to wait (only on 429)
```

**Frontend can read these**:

```typescript
const response = await fetch('/api/bookings', {
  method: 'POST',
  body: JSON.stringify(bookingData),
});

if (response.status === 429) {
  const retryAfter = response.headers.get('Retry-After');
  console.log(`Rate limited. Try again in ${retryAfter} seconds`);
}
```

---

## 8. Storage Backend

### Default (In-Memory)

```typescript
// ❌ BAD for production
ThrottlerModule.forRoot([...])
```

**Problems**:

- Resets on server restart
- Doesn't work with load balancers
- No persistence

### Redis (Production)

```typescript
// ✅ GOOD for production
import { ThrottlerStorageRedisService } from 'throttler-storage-redis';
import Redis from 'ioredis';

ThrottlerModule.forRoot({
  throttlers: [...],
  storage: new ThrottlerStorageRedisService(
    new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
    })
  ),
})
```

**Benefits**:

- Persists across restarts
- Works with load balancers
- Centralized rate limit tracking
- Multi-server coordination

---

## 9. Testing Rate Limits

### Test Public Endpoint (IP-Based)

```bash
# Test login rate limit (should fail after 5 attempts)
for i in {1..10}; do
  echo "Attempt $i:"
  curl -X POST http://localhost:8444/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong"}' \
    -w "\nHTTP Status: %{http_code}\n\n"
  sleep 0.5
done

# Expected:
# Attempt 1-5: HTTP 401 (Unauthorized — wrong password)
# Attempt 6-10: HTTP 429 (Too Many Requests — rate limited)
```

### Test User-Based Rate Limiting

```bash
# Get tokens for 2 different users
TOKEN_A=$(curl -s -X POST http://localhost:8444/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"userA@example.com","password":"pass"}' \
  | jq -r '.accessToken')

TOKEN_B=$(curl -s -X POST http://localhost:8444/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"userB@example.com","password":"pass"}' \
  | jq -r '.accessToken')

# Test User A (should get 5 bookings before limit)
for i in {1..7}; do
  echo "User A - Attempt $i:"
  curl -X POST http://localhost:8444/salon-a/bookings \
    -H "Authorization: Bearer $TOKEN_A" \
    -H "Content-Type: application/json" \
    -d '{"bookingDate":"2025-10-15","startTime":"10:00",...}' \
    -w "\nHTTP Status: %{http_code}\n\n"
done

# Test User B (should ALSO get full 5 bookings, independent of User A)
for i in {1..7}; do
  echo "User B - Attempt $i:"
  curl -X POST http://localhost:8444/salon-a/bookings \
    -H "Authorization: Bearer $TOKEN_B" \
    -H "Content-Type: application/json" \
    -d '{"bookingDate":"2025-10-15","startTime":"10:00",...}' \
    -w "\nHTTP Status: %{http_code}\n\n"
done

# Expected:
# User A: 1-5 success (201), 6-7 rate limited (429)
# User B: 1-5 success (201), 6-7 rate limited (429)
# Proof: User-based rate limiting works!
```

---

## 10. Common Rate Limit Strategies

### Booking-Heavy Operations

```typescript
// Protect critical write operations with strict limits
@Post('bookings')
@Throttle({ medium: { limit: 5, ttl: 60000 } })  // 5 per min
async createBooking() {}

// Read operations can be more lenient
@Get('availability')
@Throttle({ medium: { limit: 50, ttl: 60000 } }) // 50 per min
async checkAvailability() {}

// Bulk operations very limited
@Post('bookings/bulk-import')
@Throttle({ short: { limit: 1, ttl: 3600000 } }) // 1 per hour
async bulkImport() {}
```

### API Tier Strategy

```typescript
// Free tier users
@UseGuards(UserThrottlerGuard)
@Throttle({ medium: { limit: 10, ttl: 60000 } })  // 10/min
async listBookings() {}

// Premium tier users
@Roles('premium')
@Throttle({ medium: { limit: 100, ttl: 60000 } }) // 100/min
async listBookings() {}

// Admin users
@Roles('admin')
@Throttle({ medium: { limit: 1000, ttl: 60000 } }) // 1000/min
async listBookings() {}
```

---

## 11. Error Handling & User Communication

### Custom Error Response

```typescript
@Catch(ThrottlerException)
export class ThrottlerExceptionFilter implements ExceptionFilter {
  catch(exception: ThrottlerException, host: HttpArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    response.status(429).json({
      error: 'Too many requests',
      message: 'You have made too many requests. Please try again later.',
      retryAfter: request.headers['retry-after'],
      endpoint: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
```

### Frontend User Notification

```typescript
// React hook
function useApiWithRateLimit() {
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);

  const makeRequest = async (url, options) => {
    try {
      const response = await fetch(url, options);

      if (response.status === 429) {
        const retry = parseInt(response.headers.get('Retry-After') || '60');
        setIsRateLimited(true);
        setRetryAfter(retry);

        // Show toast
        toast.error(`Rate limited. Please try again in ${retry} seconds.`);

        return null;
      }

      setIsRateLimited(false);
      return response;
    } catch (error) {
      console.error(error);
    }
  };

  return { makeRequest, isRateLimited, retryAfter };
}
```

---

## 12. Monitoring & Metrics

### Track Rate Limit Hits

```typescript
// Log rate limit events
@Injectable()
export class RateLimitMonitor {
  constructor(private logger: Logger) {}

  onModuleInit() {
    // Log when rate limits are exceeded
    this.logger.log('Rate limiting active');
  }

  trackThrottle(userId: string, endpoint: string) {
    this.logger.warn(
      `Rate limit exceeded: user=${userId} endpoint=${endpoint}`
    );
  }
}
```

### Alert on Abuse

```typescript
// Alert if single user exceeds limits frequently
if (userThrottleCount > 100 in last 5 minutes) {
  sendAlert(`Potential abuse detected: user ${userId}`);
}
```

---

## 13. Best Practices

1. **Use Redis in Production** — Not in-memory
2. **Set Reasonable Limits** — Balance protection with UX
3. **Expose Rate Limit Headers** — Let clients know status
4. **Skip for Health Checks** — `@SkipThrottle()` for `/health`
5. **Different Limits per Operation** — Writes stricter than reads
6. **User-Based for Auth** — Fair for multi-user scenarios
7. **Monitor & Alert** — Track abnormal patterns
8. **Document Limits** — API docs should show limits
9. **Graceful Degradation** — Let clients know when limited
10. **Scale Limits with Tiers** — Premium users get higher limits

---

## 14. Summary

**Rate limiting with @nestjs/throttler**:

- ✅ Protects API from abuse
- ✅ Ensures fair resource allocation
- ✅ Configurable per endpoint
- ✅ Multiple limits (burst, minute, hour)
- ✅ Custom tracking (IP, user, tenant)
- ✅ Redis for production
- ✅ Response headers for client awareness
- ✅ Easy to test and monitor
