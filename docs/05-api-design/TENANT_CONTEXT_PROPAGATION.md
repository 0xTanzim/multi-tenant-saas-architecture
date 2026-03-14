# Tenant Context Propagation in APIs

## Overview

This document describes how tenant context flows through the API request/response lifecycle, ensuring that:

1. **Tenant identity** is established from a trusted source (JWT)
2. **Tenant context** is available at every layer
3. **Cross-tenant access** is prevented
4. **Tenant data leakage** is impossible

---

## Tenant Context Flow Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT REQUEST                           │
│   Authorization: Bearer <JWT token with tenant_id claim>         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      HTTP MIDDLEWARE                              │
│  1. Extract Authorization header                                 │
│  2. Validate JWT signature                                       │
│  3. Extract tenant_id from JWT claims                            │
│  4. Store in request context (req.tenantId)                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      GUARD LAYER                                 │
│  1. Verify request.tenantId exists                               │
│  2. Check route parameter matches (if tenant slug in route)      │
│  3. Validate tenant is not soft-deleted                          │
│  4. Load tenant capabilities (plan, features, limits)            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    CONTROLLER LAYER                              │
│  1. Extract tenant from @TenantId() decorator                    │
│  2. Verify user role/permissions for this tenant                 │
│  3. Pass tenantId to service layer                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     SERVICE LAYER                                │
│  1. Receive tenantId as first parameter                          │
│  2. Validate all queries include tenantId in WHERE clause        │
│  3. Pass to repository                                           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    REPOSITORY LAYER                              │
│  1. Enforce tenant_id in WHERE clause (MANDATORY)                │
│  2. Use composite indexes (tenant_id, ...)                       │
│  3. Prevent tenant_id to be null                                 │
│  4. Return only tenant-scoped data                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   DATABASE RESPONSE                              │
│  Return only records WHERE tenant_id = requested_tenant_id       │
└─────────────────────────────────────────────────────────────────┘
```

---

## JWT Token Structure

### Standard JWT Payload (Access Token)

```typescript
{
  // Standard OIDC claims
  "sub": "user-123",                          // User ID (Subject)
  "iss": "https://auth.example.com",          // Issuer
  "aud": "salon-api",                         // Audience
  "iat": 1620000000,                          // Issued At (Unix timestamp)
  "exp": 1620003600,                          // Expiration (1 hour)

  // Multi-tenant claims
  "tenant_id": 5,                             // Current tenant ID
  "tenant_slug": "glamour-salon",             // Tenant slug
  "active_tenant": {
    "id": 5,
    "name": "Glamour Salon",
    "slug": "glamour-salon",
    "type": "salon"
  },
  "tenant_ids": [5, 10],                      // User's accessible tenants
  "available_tenants": [                      // All user's tenants
    { "id": 5, "name": "Glamour Salon", "role": "owner" },
    { "id": 10, "name": "Boutique Salon", "role": "staff" }
  ],

  // Authorization claims
  "role": "owner",                            // User role in current tenant
  "permissions": [                            // Scoped to current tenant
    "bookings:read",
    "bookings:write",
    "staff:read",
    "staff:write"
  ],

  // Custom app claims
  "customer_id": null,                        // If user is a customer
  "staff_id": 42,                             // If user is staff
  "is_owner": true,
  "is_staff": false,
  "is_customer": false
}
```

### Refresh Token

```typescript
{
  "sub": "user-123",
  "iss": "https://auth.example.com",
  "type": "refresh",
  "iat": 1620000000,
  "exp": 1627776000,                          // 7 days
  "tenant_ids": [5, 10]                       // Allowed tenants
}
```

### Token Generation (Pseudo-code)

```typescript
async function generateTokens(user: User, tenant: Tenant, role: UserRole) {
  // Verify user is active in this tenant
  const userTenant = await userTenantRepo.findOne({
    where: { userId: user.id, tenantId: tenant.id },
  });

  if (!userTenant || userTenant.deletedAt) {
    throw new UnauthorizedException('User not in this tenant');
  }

  const permissions = getPermissions(role, tenant.type);

  const accessToken = jwt.sign(
    {
      sub: user.id,
      tenant_id: tenant.id,
      tenant_slug: tenant.slug,
      active_tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        type: tenant.type,
      },
      tenant_ids: userTenant.accessibleTenantIds,
      role: userTenant.role,
      permissions,
      staff_id: userTenant.staffId || null,
      customer_id: userTenant.customerId || null,
      is_owner: userTenant.role === 'owner',
      is_staff: userTenant.role === 'staff',
      is_customer: userTenant.role === 'customer',
    },
    jwtSecret,
    { expiresIn: '1h' }
  );

  const refreshToken = jwt.sign(
    {
      sub: user.id,
      type: 'refresh',
      tenant_ids: userTenant.accessibleTenantIds,
    },
    jwtRefreshSecret,
    { expiresIn: '7d' }
  );

  return { accessToken, refreshToken };
}
```

---

## Authorization Header Validation

### Header Format

```
Authorization: Bearer <access_token>
```

### Validation Pipeline

```typescript
async validateAuthHeader(request: Request): Promise<TenantContext> {
  // 1. Extract Authorization header
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedException('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  // 2. Verify JWT signature
  let decoded: any;
  try {
    decoded = jwt.verify(token, jwtSecret);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new UnauthorizedException('Token expired');
    }
    throw new UnauthorizedException('Invalid token signature');
  }

  // 3. Check required claims
  if (!decoded.sub || !decoded.tenant_id) {
    throw new UnauthorizedException('Missing required JWT claims (sub, tenant_id)');
  }

  // 4. Verify user still exists and is active
  const user = await userRepository.findById(decoded.sub);
  if (!user || user.deletedAt) {
    throw new UnauthorizedException('User no longer exists or is deactivated');
  }

  // 5. Verify tenant still exists and is active
  const tenant = await tenantRepository.findById(decoded.tenant_id);
  if (!tenant || tenant.deletedAt) {
    throw new ForbiddenException('Tenant no longer exists or is deactivated');
  }

  // 6. Return tenant context for request
  return {
    userId: decoded.sub,
    tenantId: decoded.tenant_id,
    tenantSlug: decoded.tenant_slug,
    role: decoded.role,
    permissions: decoded.permissions,
    accessibleTenantIds: decoded.tenant_ids
  };
}
```

---

## Request Header Validation

### X-Tenant-Id Header (Optional Override)

Some systems use an optional header to override the JWT tenant:

```
GET /api/bookings
Authorization: Bearer <token>
X-Tenant-Id: 5
```

### Validation Rules

```typescript
async validateRequestHeaders(
  request: Request,
  jwtTenantId: number
): Promise<number> {
  const xTenantId = request.headers['x-tenant-id'];

  if (!xTenantId) {
    // No override, use JWT tenant
    return jwtTenantId;
  }

  const overrideTenantId = parseInt(xTenantId as string, 10);

  if (isNaN(overrideTenantId)) {
    throw new BadRequestException('X-Tenant-Id must be a valid number');
  }

  // CRITICAL: Verify user has access to override tenant
  const userTenant = await userTenantRepository.findOne({
    where: {
      userId: request.user.id,
      tenantId: overrideTenantId
    }
  });

  if (!userTenant || userTenant.deletedAt) {
    throw new ForbiddenException(
      `User does not have access to tenant ${overrideTenantId}`
    );
  }

  // Log tenant switch for audit
  logger.info('Tenant switch via X-Tenant-Id header', {
    userId: request.user.id,
    fromTenant: jwtTenantId,
    toTenant: overrideTenantId,
    requestId: request.id
  });

  return overrideTenantId;
}
```

### Common Headers

| Header              | Purpose            | Format           | Required          |
| ------------------- | ------------------ | ---------------- | ----------------- |
| `Authorization`     | JWT authentication | `Bearer <token>` | Yes               |
| `X-Tenant-Id`       | Tenant override    | `<number>`       | No                |
| `X-Request-Id`      | Request tracing    | UUID or string   | Recommended       |
| `X-Idempotency-Key` | Idempotency        | UUID or string   | POST/PATCH/DELETE |
| `X-API-Version`     | API version        | `1.0`            | No                |
| `Accept-Language`   | Locale             | `en-US`          | No                |

---

## Tenant Mismatch Handling

### Scenario 1: Token Tenant ≠ Route Tenant

```typescript
// Route: GET /api/salons/:tenantSlug/bookings
// JWT tenant_id: 5
// Route tenantSlug: "rival-salon" (tenant_id: 10)

@Get(':tenantSlug/bookings')
@UseGuards(TenantGuard)
async getBookings(
  @Param('tenantSlug') tenantSlug: string,
  @TenantId() jwtTenantId: number
) {
  const routeTenantId = await resolveTenantSlug(tenantSlug); // Returns 10

  if (routeTenantId !== jwtTenantId) {
    throw new ForbiddenException({
      code: 'TENANT_MISMATCH',
      message: 'JWT tenant does not match route tenant',
      details: {
        jwtTenant: jwtTenantId,
        routeTenant: routeTenantId
      }
    });
  }
}
```

### Scenario 2: User Not in Tenant

```typescript
// User's JWT contains tenant_ids: [5, 10]
// User tries to access tenant_id: 15

async validateUserInTenant(userId: number, tenantId: number) {
  const userTenant = await userTenantRepository.findOne({
    where: { userId, tenantId },
    relations: ['tenant', 'user']
  });

  if (!userTenant) {
    throw new ForbiddenException({
      code: 'NOT_IN_TENANT',
      message: `User ${userId} is not a member of tenant ${tenantId}`,
      status: 403
    });
  }

  if (userTenant.deletedAt) {
    throw new ForbiddenException({
      code: 'TENANT_ACCESS_REVOKED',
      message: `User's access to tenant ${tenantId} has been revoked`,
      status: 403
    });
  }

  return userTenant;
}
```

### Scenario 3: Stale Token (User Removed from Tenant)

```typescript
// User has valid JWT with tenant_id: 5
// But user was removed from tenant 5 after token issued

@UseGuards(JwtAuthGuard, TenantGuard)
@Get('bookings')
async getBookings(@TenantId() tenantId: number) {
  // Re-check user is still in this tenant (cache-friendly)
  const isMember = await tenantMemberCache.isMember(request.user.id, tenantId);

  if (!isMember) {
    throw new ForbiddenException({
      code: 'TENANT_ACCESS_REVOKED',
      message: 'Your access to this tenant has been revoked',
      advice: 'Please log in again to refresh your token'
    });
  }
}
```

---

## Tenant Context in Logs

### Structured Logging with Tenant Context

All logs must include tenant context for debuggability and audit:

```typescript
logger.info('Booking created', {
  // Standard fields
  action: 'booking.created',
  timestamp: new Date().toISOString(),

  // Tenant context (MANDATORY)
  tenantId: 5,
  tenantSlug: 'glamour-salon',

  // User context
  userId: 'user-123',
  userRole: 'owner',

  // Request context
  requestId: 'req-abc123',
  method: 'POST',
  path: '/api/bookings',
  statusCode: 201,

  // Business data
  bookingId: 'booking-456',
  customerId: 'customer-789',
  serviceId: 'service-001',
  amount: '149.99',
});
```

### Log Aggregation Query

```sql
-- Find all actions for tenant 5
SELECT * FROM logs WHERE tenantId = 5 AND timestamp > NOW() - INTERVAL 24 HOUR;

-- Find specific user actions
SELECT * FROM logs
WHERE tenantId = 5
  AND userId = 'user-123'
  AND action LIKE 'booking%';

-- Audit trail for booking
SELECT * FROM logs
WHERE tenantId = 5
  AND bookingId = 'booking-456'
ORDER BY timestamp ASC;
```

---

## Tenant Context in Caching

### Cache Key Pattern

Always prefix cache keys with tenant_id:

```typescript
// ✅ CORRECT: Tenant-scoped key
const key = `tenant:${tenantId}:bookings:${bookingId}`;
await cache.get(key);

// ❌ WRONG: Shared across tenants
const key = `bookings:${bookingId}`;
```

### Cache Implementation Example

```typescript
async getBooking(tenantId: number, bookingId: string): Promise<Booking> {
  // 1. Check cache (tenant-scoped)
  const cacheKey = `tenant:${tenantId}:booking:${bookingId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  // 2. Query database (tenant-filtered)
  const booking = await bookingRepository.findOne({
    where: { id: bookingId, tenantId },
    relations: ['service', 'staff']
  });

  if (!booking) {
    throw new NotFoundException(`Booking not found`);
  }

  // 3. Cache result
  await cache.set(cacheKey, booking, { ttl: 3600 });

  return booking;
}
```

### Cache Invalidation on Tenant Switch

When a user switches tenants, invalidate relevant caches:

```typescript
async switchTenant(userId: number, newTenantId: number) {
  // 1. Generate new token with new tenant
  const tokens = await generateTokens(user, newTenant);

  // 2. Invalidate old tenant caches
  const oldTenantId = currentTenant.id;
  await cache.invalidatePattern(`tenant:${oldTenantId}:user:${userId}:*`);

  // 3. Populate new tenant cache
  await cache.set(`tenant:${newTenantId}:user:${userId}:permissions`, permissions);

  return { tokens, tenantId: newTenantId };
}
```

---

## Security Checklist

- [ ] **JWT Validation**: Signature verified with current secret
- [ ] **Token Expiry**: Access tokens < 1 hour, refresh tokens < 7 days
- [ ] **Tenant Matching**: Route tenant always matches JWT tenant
- [ ] **User Membership**: Re-validate user is still in tenant
- [ ] **Permissions**: User has required permissions for operation
- [ ] **Data Filtering**: Repository queries include `tenantId` in WHERE clause
- [ ] **Logs**: All logs include tenantId
- [ ] **Cache Keys**: All cache keys include tenantId
- [ ] **Error Messages**: No leakage of other tenant data in errors
- [ ] **Cross-Tenant Queries**: Impossible (design prevents it)

---

## References

- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)
- [OWASP Multi-Tenancy](https://owasp.org/www-community/attacks/Multi-Tenancy_Attacks)
- [Auth0 Token Structure](https://auth0.com/docs/get-started/tokens)
