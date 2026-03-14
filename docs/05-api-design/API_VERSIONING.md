# API Versioning Strategy

## Overview

This document defines the versioning strategy, backward compatibility guarantees, deprecation timeline, breaking change communication, and version routing for multi-tenant SaaS APIs. The goal is to:

1. **Support multiple versions** simultaneously during transitions
2. **Plan deprecations clearly** (30/60/90 day notice)
3. **Communicate breaking changes** transparently
4. **Minimize client friction** during updates

---

## Versioning Principles

### Core Rules

1. **Semantic Versioning**: `MAJOR.MINOR.PATCH`

   - **MAJOR**: Breaking changes (requires client update)
   - **MINOR**: Backward-compatible additions (new fields, new endpoints)
   - **PATCH**: Backward-compatible bug fixes

2. **Version in Media-Type or Header** (not URL)

   - ✅ `Accept: application/vnd.api+json;version=2`
   - ✅ `X-API-Version: 2`
   - ❌ `/api/v2/bookings` (version in URL)

3. **Backward Compatibility Guarantee**

   - All PATCH and MINOR versions are **100% backward compatible**
   - No field removals, no behavior changes
   - New fields are always **optional**

4. **Longer Support Windows**
   - Current version: 12 months active support
   - Previous version: 6 months support
   - End-of-life version: 2 weeks notice before hard cutoff

---

## Version Routing

### Header-Based Routing (Recommended)

```typescript
// Client specifies version in header
GET /api/bookings
X-API-Version: 2
```

### Media-Type Routing

```typescript
// Client specifies in Accept header
GET / api / bookings;
Accept: application / vnd.api + json;
version = 2;
```

### Query Parameter (Fallback)

```typescript
// For API explorers, webhooks
GET /api/bookings?apiVersion=2
```

### Implementation

```typescript
// Middleware to extract and validate version
import { Request, Response, NextFunction } from 'express';

export function apiVersionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // 1. Extract version from multiple sources
  let version = req.headers['x-api-version'] as string;

  if (!version) {
    // Try Accept header
    const acceptHeader = req.headers['accept'] || '';
    const match = acceptHeader.match(/version=(\d+)/);
    if (match) version = match[1];
  }

  if (!version) {
    // Try query parameter
    version = req.query.apiVersion as string;
  }

  if (!version) {
    // Default to latest
    version = LATEST_API_VERSION;
  }

  // 2. Validate version is supported
  const numVersion = parseInt(version, 10);
  if (!SUPPORTED_VERSIONS.includes(numVersion)) {
    return res.status(400).json({
      error: {
        code: 'UNSUPPORTED_API_VERSION',
        message: `API version ${version} is no longer supported`,
        details: {
          requestedVersion: numVersion,
          supportedVersions: SUPPORTED_VERSIONS,
          latestVersion: LATEST_API_VERSION,
          deprecationSchedule: getDeprecationSchedule(),
        },
      },
    });
  }

  // 3. Store in request for use in controllers
  req.apiVersion = numVersion;
  res.setHeader('X-API-Version', numVersion);

  next();
}

// Define supported versions
const LATEST_API_VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2];

const DEPRECATION_SCHEDULE = {
  1: {
    deprecated: '2025-01-01',
    lastSupported: '2025-07-01',
    hardCutoff: '2025-07-15',
  },
};

function getDeprecationSchedule() {
  return Object.entries(DEPRECATION_SCHEDULE).map(([version, dates]) => ({
    version: parseInt(version),
    ...dates,
  }));
}
```

---

## Backward Compatibility Strategy

### What IS Backward Compatible (Safe)

```typescript
// 1. Adding optional fields
// OLD: { "id": 1, "status": "confirmed" }
// NEW: { "id": 1, "status": "confirmed", "notes": null }  ← OK

// 2. Adding new endpoints
// POST /api/v2/bookings/notify  ← OK (old client doesn't call it)

// 3. Expanding enums (with unknown value handling)
// OLD: status ∈ ["confirmed", "cancelled"]
// NEW: status ∈ ["confirmed", "cancelled", "no_show"]  ← OK

// 4. Adding optional query parameters
// GET /api/bookings?includeDeleted=false  ← OK (old client omits it)

// 5. Changing internal implementation
// Same response, different database query  ← OK
```

### What IS NOT Backward Compatible (Breaking)

```typescript
// 1. Removing fields
// { "id": 1, "status": "confirmed" } → { "id": 1 }  ✗ BREAKING

// 2. Renaming fields
// { "customer_name" } → { "customerName" }  ✗ BREAKING

// 3. Changing field types
// { "price": "149.99" } → { "price": 149.99 }  ✗ BREAKING

// 4. Removing endpoints
// DELETE /api/customers/:id deprecated, use /api/customers/:id?method=delete  ✗ BREAKING

// 5. Changing status codes
// 200 OK → 201 Created  ✗ BREAKING

// 6. Changing required fields
// { "id": 1, "status": "confirmed" } → { "id": 1, "status": "confirmed", "notes": "required" }  ✗ BREAKING
```

---

## Versioning API Responses

### Version-Specific Response Transforms

```typescript
@Get()
async getBookings(@Req() req: Request): Promise<any> {
  const bookings = await bookingService.getBookings();

  // Transform based on API version
  return this.transformByVersion(bookings, req.apiVersion);
}

private transformByVersion(bookings: any[], version: number) {
  if (version === 1) {
    // Legacy format
    return bookings.map(booking => ({
      id: booking.id,
      customer_name: booking.customer.name,  // Old naming
      status: booking.status,
      created_at: booking.createdAt
    }));
  }

  if (version === 2) {
    // New format
    return bookings.map(booking => ({
      id: booking.id,
      customerId: booking.customerId,
      customerName: booking.customer.name,
      customer: {
        id: booking.customer.id,
        name: booking.customer.name,
        email: booking.customer.email
      },
      status: booking.status,
      createdAt: booking.createdAt,
      notes: booking.notes || null
    }));
  }
}
```

### Version Adapter Pattern

```typescript
// Adapter for each API version
abstract class BookingAdapter {
  abstract toDTO(booking: BookingEntity): any;
  abstract fromDTO(dto: any): Partial<BookingEntity>;
}

class BookingV1Adapter extends BookingAdapter {
  toDTO(booking: BookingEntity) {
    return {
      id: booking.id,
      customer_name: booking.customer.name,
      status: booking.status,
      created_at: booking.createdAt
    };
  }

  fromDTO(dto: any) {
    return {
      status: dto.status
    };
  }
}

class BookingV2Adapter extends BookingAdapter {
  toDTO(booking: BookingEntity) {
    return {
      id: booking.id,
      customerId: booking.customerId,
      customerName: booking.customer.name,
      status: booking.status,
      createdAt: booking.createdAt,
      notes: booking.notes || null
    };
  }

  fromDTO(dto: any) {
    return {
      customerId: dto.customerId,
      status: dto.status,
      notes: dto.notes
    };
  }
}

// Use adapter in controller
@Get()
async getBookings(@Req() req: Request) {
  const bookings = await bookingService.getBookings();
  const adapter = AdapterFactory.getAdapter('Booking', req.apiVersion);
  return bookings.map(b => adapter.toDTO(b));
}
```

---

## Breaking Changes & Deprecation Timeline

### Deprecation Path (90 Days Total)

```
Day 1 (Launch)
├─ API v3 released (new features)
├─ v2 still fully supported
├─ Deprecation notice in docs
└─ Emails sent to active v2 users

Day 1-30: 30-Day Notice Period
├─ v2 operational (no degradation)
├─ Blog post: "API v2 deprecation plan"
├─ Email: "Plan your migration"
└─ Migration guide available

Day 31-60: 60-Day Notice Period
├─ v2 operational (no degradation)
├─ Response headers warn: "X-API-Deprecated: true"
├─ Headers show: "X-API-Sunset: 2025-08-15"
└─ Escalate to tenant admins

Day 61-90: 90-Day Notice Period
├─ v2 operational (no degradation)
├─ In-app notification: "v2 ending in 30 days"
├─ Dashboard alert for v2 users
└─ Final support push

Day 91+: Hard Cutoff
├─ v2 returns 410 Gone
├─ Redirect to v3 docs
└─ Support escalation
```

### Deprecation Response Headers

After 30 days of deprecation notice:

```
HTTP/1.1 200 OK
X-API-Deprecated: true
X-API-Sunset: Sun, 15 Aug 2025 00:00:00 GMT
X-API-Migration-Guide: https://docs.api.com/migration-v2-to-v3
Warning: 299 - "API version 2 is deprecated and will sunset on 2025-08-15"
Deprecation: true

{
  "data": { /* response */ },
  "meta": {
    "deprecation": {
      "version": 2,
      "status": "deprecated",
      "sunsetDate": "2025-08-15T00:00:00Z",
      "daysRemaining": 45,
      "migrationGuide": "https://docs.api.com/migration-v2-to-v3"
    }
  }
}
```

### Deprecation Communication

```typescript
// 1. Email to tenant admins
Subject: "API v2 Deprecation Notice - Action Required"

Dear {tenant.name},

Your integration uses API v2, which will be retired on August 15, 2025 (45 days).

Migration steps:
1. Review migration guide: https://docs.api.com/migration-v2-to-v3
2. Update your client code to use v3
3. Test in sandbox environment
4. Deploy to production by August 15

v3 highlights:
- Better error handling (new error codes)
- New fields in responses
- Improved pagination (cursor-based)

Questions? Email support@api.com or visit https://community.api.com


// 2. Response header warning
X-API-Deprecated: true
X-API-Sunset: Sun, 15 Aug 2025 00:00:00 GMT
Deprecation: true


// 3. In-app notification (for SPA clients)
{
  "deprecation": {
    "status": "active",
    "version": 2,
    "sunsetDate": "2025-08-15T00:00:00Z",
    "message": "Your API client is using a deprecated version. Please update.",
    "actionUrl": "https://docs.api.com/migration-v2-to-v3"
  }
}


// 4. Dashboard alert
⚠️ API Deprecation Notice
Your application uses API v2, which will be retired on August 15, 2025.
View migration guide →
```

---

## Migration Guide Generation

### Auto-Generated Diff

````
# Migrating from API v2 to v3

## New Endpoints

- POST /api/bookings/:id:confirm (replaces PATCH with status change)
- GET /api/availability (new availability endpoint)

## Removed Endpoints

- DELETE /api/bookings (use PATCH with status: "cancelled")

## Response Changes

### GET /api/bookings

**v2 Response:**
```json
{
  "customer_name": "John Doe",
  "created_at": "2025-05-10T14:30:00Z"
}
````

**v3 Response:**

```json
{
  "customerId": 123,
  "customerName": "John Doe",
  "customer": {
    "id": 123,
    "name": "John Doe",
    "email": "john@example.com"
  },
  "createdAt": "2025-05-10T14:30:00Z"
}
```

**Migration:**

- Replace `customer_name` → `customerName` or `customer.name`
- Replace `created_at` → `createdAt`
- Add optional `customer` object (new field)

## New Status Codes

- 202 Accepted (async operations)
- 410 Gone (removed endpoints)

## New Required Headers

- None (all optional)

## Deprecated Features

- query parameter `sort_by` → use `sort` instead

````

---

## Version Sunset Process

### Hard Cutoff Response

After deprecation period:

```typescript
HTTP/1.1 410 Gone
Sunset: Sun, 15 Aug 2025 00:00:00 GMT
X-API-Sunset-Date: 2025-08-15T00:00:00Z

{
  "error": {
    "code": "API_VERSION_SUNSET",
    "message": "API v2 is no longer supported",
    "details": {
      "sunsettedVersion": 2,
      "sunsettedDate": "2025-08-15T00:00:00Z",
      "currentVersion": 3,
      "migrationGuide": "https://docs.api.com/migration-v2-to-v3"
    }
  }
}
````

### Redirect to Latest

```typescript
// Middleware to redirect old clients
if (req.apiVersion < LATEST_VERSION) {
  res.status(301);
  res.setHeader('Location', '/api/docs?version=' + LATEST_VERSION);
  return res.json({
    error: {
      code: 'PLEASE_UPGRADE',
      message: 'This API version is no longer supported. Please upgrade.',
      latestVersion: LATEST_VERSION,
    },
  });
}
```

---

## Version Management Checklist

- [ ] **Versioning scheme**: Semantic Versioning (MAJOR.MINOR.PATCH)
- [ ] **Version header**: Included in every response
- [ ] **Deprecation timeline**: 30/60/90 day notice
- [ ] **Migration guide**: Auto-generated or maintained
- [ ] **Backward compatibility**: PATCH and MINOR always safe
- [ ] **Response adapters**: Version-specific transforms
- [ ] **Communication**: Email, headers, in-app notifications
- [ ] **Hard cutoff**: 410 Gone after sunset date
- [ ] **Testing**: Test all supported versions in CI/CD
- [ ] **Monitoring**: Track version usage by client

---

## Example: v2 → v3 Migration

### Breaking Changes Introduced

1. **Response field rename**: `customer_name` → `customerName`
2. **New optional field**: `customer` object with nested data
3. **New endpoint**: `POST /api/bookings/:id:confirm`
4. **Deprecated endpoint**: `PATCH /api/bookings/:id` (use confirm instead)

### Timeline

```
May 1, 2025:    v3 released, v2 deprecated
May 1-31:       30-day notice (emails sent)
June 1-30:      60-day notice (headers warn)
July 1-31:      90-day notice (dashboard alerts)
Aug 15, 2025:   Hard cutoff (v2 returns 410 Gone)
```

### Client Migration Path

```typescript
// OLD CODE (v2)
const booking = await fetch('/api/bookings/123', {
  headers: { 'X-API-Version': '2' },
}).then((r) => r.json());
const name = booking.customer_name;

// NEW CODE (v3)
const booking = await fetch('/api/bookings/123', {
  headers: { 'X-API-Version': '3' },
}).then((r) => r.json());
const name = booking.customerName; // or booking.customer.name
```

---

## References

- [Semantic Versioning](https://semver.org/)
- [API Deprecation Best Practices](https://tools.ietf.org/html/draft-dalal-api-versioning-extension)
- [HTTP Sunset Header](https://tools.ietf.org/html/rfc8594)
- [Stripe API Versioning](https://stripe.com/docs/api/versioning)
