# API Design Patterns for Multi-Tenant SaaS

## Overview

This document defines RESTful API conventions, naming patterns, request/response structure, error handling, and idempotency strategies for multi-tenant SaaS systems. These patterns ensure consistent, scalable, and tenant-safe APIs.

## Table of Contents

- [RESTful Conventions](#restful-conventions)
- [Endpoint Naming Patterns](#endpoint-naming-patterns)
- [Request/Response Structure](#requestresponse-structure)
- [HTTP Status Codes](#http-status-codes)
- [Idempotency Patterns](#idempotency-patterns)
- [Pagination](#pagination)
- [Filtering & Sorting](#filtering--sorting)
- [API Documentation](#api-documentation)

---

## RESTful Conventions

### Design Principles

1. **Tenant-Neutral URLs**: Tenant context flows via JWT/authorization header, not URL path

   - ✅ `POST /api/bookings` (tenant from JWT)
   - ❌ `POST /api/tenants/123/bookings` (leaks tenant_id in URL)

2. **Resource-Centric Naming**: Use nouns, not verbs

   - ✅ `GET /api/customers`
   - ❌ `GET /api/getCustomers`

3. **HTTP Method Semantics**:

   - `GET`: Retrieve resource(s) — idempotent, cacheable
   - `POST`: Create resource — side effects expected
   - `PATCH`: Partial update — side effects expected
   - `PUT`: Full resource replacement — rarely needed
   - `DELETE`: Remove resource — side effects expected

4. **Version in Media-Type or Header** (not URL)
   - ✅ `Accept: application/vnd.api+json;version=2`
   - ✅ `X-API-Version: 2`
   - ❌ `/api/v2/bookings` (version in URL)

### Soft Delete Pattern

Always use soft deletes for tenant-scoped resources:

```
DELETE /api/bookings/:id → Sets deleted_at = NOW()
GET /api/bookings → Returns only non-deleted records
GET /api/bookings?includeDeleted=true → Admin/audit access
```

---

## Endpoint Naming Patterns

### Standard CRUD Operations

| Operation | Method | URL Pattern          | Idempotent |
| --------- | ------ | -------------------- | ---------- |
| List      | GET    | `/api/resources`     | Yes        |
| Get       | GET    | `/api/resources/:id` | Yes        |
| Create    | POST   | `/api/resources`     | No         |
| Update    | PATCH  | `/api/resources/:id` | No         |
| Replace   | PUT    | `/api/resources/:id` | No         |
| Delete    | DELETE | `/api/resources/:id` | No         |

### Nested Resources (Subordinates)

Nest up to **2 levels** only:

```
GET /api/salons/salon-1/services              ← Scoped to salon 1
GET /api/salons/salon-1/services/service-2    ← Specific service
PATCH /api/salons/salon-1/services/service-2  ← Update service
```

Use query parameters for deeper nesting:

```
GET /api/services?salonId=1&categoryId=2
```

### Action Endpoints (Non-Resource)

Use colon-prefixed sub-resources for actions:

```
POST /api/bookings/:id:confirm     → Confirm booking
POST /api/bookings/:id:cancel      → Cancel booking
POST /api/wallets/me:topup         → Top-up wallet
POST /api/customers/:id:sendInvite → Send invite
```

**Alternative (more REST-compliant)**: Use state fields

```
PATCH /api/bookings/:id { status: "confirmed" }
```

---

## Request/Response Structure

### Standard Request Envelope

```typescript
// Generic request (most calls)
{}

// Bulk operations
{
  "items": [{ /* resource */ }, { /* resource */ }]
}

// Filtered requests
{
  "filter": { "status": "completed", "rating": { "$gte": 4 } },
  "sort": [{ "field": "createdAt", "direction": "desc" }],
  "pagination": { "page": 1, "limit": 20 }
}
```

### Standard Response Envelope

```typescript
// Success (200, 201)
{
  "data": {
    "id": "booking-123",
    "status": "confirmed",
    "createdAt": "2025-05-10T14:30:00Z",
    // ... other fields
  },
  "meta": {
    "timestamp": "2025-05-10T14:30:00Z",
    "version": "1.0",
    "requestId": "req-abc123"
  }
}

// List response (200)
{
  "data": [
    { "id": "booking-1", ... },
    { "id": "booking-2", ... }
  ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "pages": 8
    },
    "timestamp": "2025-05-10T14:30:00Z"
  }
}

// Error (4xx, 5xx)
{
  "error": {
    "code": "INVALID_TENANT_ACCESS",
    "message": "You do not have access to this resource",
    "details": {
      "resourceId": "booking-123",
      "requestedTenant": 5
    },
    "requestId": "req-abc123"
  }
}
```

### Response Field Guidelines

- **timestamps**: ISO 8601 format, always UTC
- **ids**: Unique identifiers (UUID or nanoid), consistent per resource
- **enums**: Lowercase strings (not integers)
- **booleans**: Explicit (never null for boolean fields)
- **money**: Decimal strings to avoid floating-point errors

```typescript
// Good
{
  "price": "149.99",
  "currency": "USD",
  "status": "confirmed",
  "isActive": true,
  "createdAt": "2025-05-10T14:30:00Z"
}
```

---

## HTTP Status Codes

### Success (2xx)

| Code | Usage                                   | Body                 |
| ---- | --------------------------------------- | -------------------- |
| 200  | GET successful, PATCH/DELETE successful | Resource or summary  |
| 201  | POST created                            | Created resource     |
| 202  | Async operation accepted                | Task ID / status URL |
| 204  | DELETE successful (no content)          | Empty                |

### Client Errors (4xx)

| Code | Usage                | When                                                          |
| ---- | -------------------- | ------------------------------------------------------------- |
| 400  | Bad Request          | Invalid input, missing required fields, schema mismatch       |
| 401  | Unauthorized         | Missing/invalid JWT, expired token                            |
| 403  | Forbidden            | Valid token but insufficient permissions or tenant mismatch   |
| 404  | Not Found            | Resource doesn't exist or is soft-deleted                     |
| 409  | Conflict             | Unique constraint violation, race condition (optimistic lock) |
| 422  | Unprocessable Entity | Semantic validation failure (e.g., can't book in the past)    |
| 429  | Too Many Requests    | Rate limit exceeded                                           |

### Server Errors (5xx)

| Code | Usage                 | When                                      |
| ---- | --------------------- | ----------------------------------------- |
| 500  | Internal Server Error | Unhandled exception, unexpected condition |
| 502  | Bad Gateway           | Downstream service unavailable            |
| 503  | Service Unavailable   | Maintenance, overloaded, degraded mode    |
| 504  | Gateway Timeout       | Request exceeded timeout                  |

### Tenant-Specific Status Codes

```typescript
// 403 Forbidden — Tenant mismatch
{
  "error": {
    "code": "TENANT_MISMATCH",
    "message": "Access denied: tenant context does not match resource",
    "status": 403
  }
}

// 403 Forbidden — Cross-tenant data request
{
  "error": {
    "code": "CROSS_TENANT_ACCESS_DENIED",
    "message": "Cannot access resources from different tenant",
    "status": 403
  }
}

// 402 Payment Required — Quota exceeded
{
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "Monthly API call limit reached",
    "status": 402,
    "details": {
      "quotaType": "api_calls",
      "limit": 100000,
      "current": 100000,
      "resetAt": "2025-06-10T00:00:00Z"
    }
  }
}
```

---

## Idempotency Patterns

### Problem

Duplicate requests due to network failures can create duplicate resources or side effects.

### Solution: Idempotency Key

All **non-idempotent operations** (POST, PATCH, DELETE) require an `Idempotency-Key` header:

```
POST /api/bookings
Idempotency-Key: user-123-booking-20250510-req1
Content-Type: application/json

{
  "serviceId": 5,
  "staffId": 10,
  "startTime": "2025-05-10T14:30:00Z"
}
```

### Server Implementation

```typescript
// 1. Check cache for existing key
const cachedResponse = await idempotencyCache.get(idempotencyKey);
if (cachedResponse) {
  return cachedResponse; // Return cached result immediately
}

// 2. Acquire lock (prevent race conditions)
const lock = await lockService.acquire(`idempotency:${idempotencyKey}`, {
  timeout: 5000,
});

try {
  // 3. Execute operation
  const result = await service.createBooking(request);

  // 4. Cache result (TTL: 24 hours)
  await idempotencyCache.set(idempotencyKey, result, { ttl: 86400 });

  return result;
} finally {
  await lock.release();
}
```

### Client Implementation

```typescript
// Generate deterministic key
const idempotencyKey = `${userId}-booking-${Date.now()}-${Math.random()}`;

// Retry with same key
for (let i = 0; i < 3; i++) {
  try {
    const response = await fetch('/api/bookings', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return response.json();
  } catch (error) {
    if (i < 2) await delay(1000 * (i + 1)); // Exponential backoff
    else throw error;
  }
}
```

### Idempotency Key Format

Use a deterministic format:

```
{user-id}-{operation}-{timestamp}-{nonce}
user-123-booking-20250510-req1
```

Or ULID for randomness:

```
01ARZ3NDEKTSV4RRFFQ69G5FAV
```

### Idempotency Cache

- **TTL**: 24 hours (or per SLA)
- **Storage**: Redis for performance
- **Key namespace**: `idempotency:{key}`
- **Timeout**: 5-10 seconds per operation

---

## Pagination

### Cursor-Based Pagination (Recommended)

Cursor-based is stable when data changes:

```
GET /api/bookings?limit=20&cursor=eyJpZCI6IDEwMDEsICJzb3J0IjogIWNyZWF0ZWRBdCJ9

Response:
{
  "data": [ /* 20 bookings */ ],
  "meta": {
    "pagination": {
      "limit": 20,
      "nextCursor": "eyJpZCI6IDEwMjAsICJzb3J0IjogIWNyZWF0ZWRBdCJ9",
      "prevCursor": "eyJpZCI6IDk4MCwgInNvcnQiOiAiY3JlYXRlZEF0In0=",
      "hasNextPage": true,
      "hasPrevPage": true
    }
  }
}
```

### Offset-Based Pagination (Simple, Less Stable)

```
GET /api/bookings?page=1&limit=20

Response:
{
  "data": [ /* 20 bookings */ ],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 250,
      "pages": 13
    }
  }
}
```

### Pagination Guidelines

- **Default limit**: 20 (adjust per use case)
- **Max limit**: 100 (prevent abuse)
- **Cursor encoding**: Base64 for human-readability, opaque format
- **Total count**: Include only if < 10K records (expensive)

---

## Filtering & Sorting

### Query Parameter Syntax

```typescript
// Filter operators
GET /api/bookings?status=confirmed&rating[gte]=4&rating[lte]=5
GET /api/bookings?createdAt[after]=2025-01-01&createdAt[before]=2025-12-31
GET /api/bookings?customerId[in]=1,2,3

// Sorting
GET /api/bookings?sort=-createdAt,status
  // → Sort by createdAt DESC, then by status ASC

// Full example
GET /api/bookings?status=confirmed&rating[gte]=4&sort=-createdAt&limit=20&page=1
```

### Filter Operators

| Operator      | JSON                                   | URL                     |
| ------------- | -------------------------------------- | ----------------------- |
| Equal         | `{ "status": "confirmed" }`            | `?status=confirmed`     |
| Not Equal     | `{ "status": { "$ne": "cancelled" } }` | `?status[ne]=cancelled` |
| Greater Than  | `{ "rating": { "$gt": 4 } }`           | `?rating[gt]=4`         |
| Greater/Equal | `{ "rating": { "$gte": 4 } }`          | `?rating[gte]=4`        |
| Less Than     | `{ "rating": { "$lt": 5 } }`           | `?rating[lt]=5`         |
| In Array      | `{ "id": { "$in": [1, 2, 3] } }`       | `?id[in]=1,2,3`         |
| Exists        | `{ "notes": { "$exists": true } }`     | `?notes[exists]=true`   |
| Text Search   | `{ "$text": { "$search": "salon" } }`  | `?search=salon`         |

### Default Sorting

Always sort by predictable key (e.g., `createdAt DESC`):

```typescript
// Default: newest first
GET /api/bookings  →  sort = "-createdAt"
```

---

## API Documentation

### Swagger/OpenAPI Integration

Every endpoint must include:

```typescript
@Get()
@ApiOperation({ summary: 'List customer bookings' })
@ApiOkResponse({
  type: BookingHistoryResponseDto,
  description: 'List of bookings for the authenticated customer'
})
@ApiBadRequestResponse({
  schema: {
    example: {
      error: {
        code: 'INVALID_TENANT_ACCESS',
        message: 'Tenant mismatch'
      }
    }
  }
})
@ApiBearerAuth()
@UseGuards(TenantGuard, JwtAuthGuard)
async getBookings(
  @Query(ValidationPipe) query: BookingHistoryQueryDto
): Promise<BookingHistoryResponseDto> {
  // ...
}
```

### Documentation Checklist

- [ ] **Summary**: One-liner describing the operation
- [ ] **Description**: Detailed behavior, edge cases, side effects
- [ ] **Parameters**: Type, required/optional, constraints
- [ ] **Responses**: Success (2xx), client errors (4xx), server errors (5xx)
- [ ] **Authentication**: Required auth method (Bearer, API Key, etc.)
- [ ] **Pagination**: If applicable
- [ ] **Rate Limiting**: If applicable
- [ ] **Examples**: Request & response JSON snippets
- [ ] **Tenant Isolation**: How tenant context is validated

---

## Best Practices Summary

| Practice                        | Why                              | Example                                |
| ------------------------------- | -------------------------------- | -------------------------------------- |
| Tenant context via JWT, not URL | Security, no information leakage | `Authorization: Bearer token`          |
| Resource-centric naming         | Clarity, discoverability         | `/api/bookings` not `/api/getBookings` |
| Soft deletes                    | Audit trail, data recovery       | `deleted_at` field, not hard DELETE    |
| Idempotency keys                | Reliable POST/PATCH/DELETE       | `Idempotency-Key` header               |
| Cursor pagination               | Stable with dynamic data         | Use cursors for bookings/feeds         |
| Explicit error codes            | Programmatic error handling      | `TENANT_MISMATCH`, `QUOTA_EXCEEDED`    |
| Comprehensive logging           | Debugging, audit                 | Request ID + tenant + user             |
| Async operations (202)          | Slow operations don't time out   | Batch imports, report generation       |

---

## References

- [REST Architectural Principles](https://restfulapi.net/)
- [JSON:API Specification](https://jsonapi.org/)
- [OpenAPI Specification](https://spec.openapis.org/)
- [Idempotency Best Practices](https://stripe.com/blog/idempotency)
