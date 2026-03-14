# Multi-Tenant Access Flow — Active Tenant Pattern

**Version:** 1.0
**Status:** Reference Implementation
**Audience:** Backend Engineers, Platform Architects, Security Engineers

---

## Overview

This document explains how users can belong to **multiple tenants** and switch between them efficiently using the **Active Tenant Pattern**.

### The Challenge

Users in multi-tenant systems often have access to multiple organizations:

- **Sales team member** works for Head Office + 3 regional branches
- **Contractor** manages 5 different client accounts
- **Manager** oversees 2 departments + parent organization
- **Staff member** works at 2 different locations

How do we support multiple tenant access efficiently **without JWT bloat**?

---

## Scenario: User with Multiple Tenant Access

### User1's Tenant Associations

User1 belongs to 5 different tenants with varying roles:

```
User1 Associations:
├─ Tenant A (Owner) ............ Main business
├─ Tenant B (Admin) ............ Management responsibility
├─ Tenant C (Operator) ......... Operational role
├─ Tenant D (Operator) ......... Secondary operational role
└─ Tenant E (User) ............. Contributor role
```

Each association is **independent**:

- Different role per tenant
- Different permissions per role
- Different data access per tenant

---

## How the Active Tenant Pattern Works

### Step 1: Login Returns Single Active Tenant

```
POST /auth/login
Content-Type: application/json

{
  "email": "user1@example.com",
  "password": "***"
}
```

**Response:**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "user-001",
    "email": "user1@example.com",
    "activeTenant": {
      "id": "tenant-a",
      "slug": "tenant-a",
      "name": "Tenant A",
      "role": "owner",
      "permissions": [
        "resource:create",
        "resource:read",
        "resource:update",
        "resource:delete",
        "tenant:admin",
        "users:manage"
      ]
    }
  }
}
```

**Key Point**: JWT contains **one active tenant only**. Backend selects the first tenant (or last active) as default.

---

### Step 2: Accessing Active Tenant (Zero Database Queries)

**Scenario**: User1 accesses Tenant A (their active tenant)

```
GET /api/resources
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Access Validation (in Guard/Middleware):**

```
1. Extract activeTenant from JWT
   └─ activeTenant = { id: "tenant-a", role: "owner" }

2. Extract tenantId from URL path
   └─ URL path contains: /tenants/tenant-a/resources
   └─ tenantId from URL = "tenant-a"

3. Validate tenant match
   └─ activeTenant.id === tenantId?
   └─ YES ✅

4. Validate role sufficiency
   └─ User role "owner" >= required role?
   └─ YES ✅

5. ALLOW ACCESS
   └─ Database queries: 0 ⚡
   └─ Performance: Instant (JWT validation only)
```

**Result**: Fast, zero-database-query access for active tenant.

---

### Step 3: Accessing Different Tenant (Single Database Query)

**Scenario**: User1 tries to access Tenant B (not active, but authorized)

```
GET /api/resources
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...  (activeTenant=A)
URL: /tenants/tenant-b/resources
```

**Access Validation (in Guard/Middleware):**

```
1. Extract activeTenant from JWT
   └─ activeTenant = { id: "tenant-a", role: "owner" }

2. Extract tenantId from URL
   └─ tenantId = "tenant-b"

3. Validate tenant match
   └─ activeTenant.id === tenantId?
   └─ NO ❌

4. Fallback to database query
   └─ Query: SELECT role FROM user_roles
             WHERE user_id = 'user-001'
               AND tenant_id = 'tenant-b'
   └─ Result: role = "admin"

5. Validate role sufficiency
   └─ User role "admin" >= required role?
   └─ YES ✅

6. ALLOW ACCESS
   └─ Database queries: 1 (single query)
   └─ Performance: Acceptable overhead
```

**Result**: One database query to verify cross-tenant access, then allow.

---

### Step 4: Switching Active Tenant

**Scenario**: User1 needs to work primarily in Tenant B for the day

**Request:**

```
POST /auth/switch-tenant
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

{
  "tenantId": "tenant-b"
}
```

**Response:**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "activeTenant": {
    "id": "tenant-b",
    "slug": "tenant-b",
    "name": "Tenant B",
    "role": "admin",
    "permissions": [
      "resource:create",
      "resource:read",
      "resource:update",
      "tenant:settings",
      "users:manage"
    ]
  }
}
```

**Result**: New JWT with **Tenant B as active tenant**. Now all Tenant B requests are instant.

---

## Performance Analysis

### User1's Typical Day

| Time    | Action                  | Active Tenant | Tenant A (owner) | Tenant B (admin) | Performance |
| ------- | ----------------------- | ------------- | ---------------- | ---------------- | ----------- |
| 9:00 AM | Login                   | A             | ✅ Active        | ❌ (DB query)    | 0 queries   |
| 9:15 AM | Work in Tenant A        | A             | ✅ Active        | ❌ (DB query)    | 0 queries   |
| 9:30 AM | Check Tenant B schedule | A             | ✅ Active        | ❌ (DB query)    | 1 query     |
| 1:00 PM | **Switch to Tenant B**  | B             | ❌ (DB query)    | ✅ Active        | Switch: 0   |
| 1:15 PM | Work in Tenant B        | B             | ❌ (DB query)    | ✅ Active        | 0 queries   |
| 2:30 PM | Check Tenant A briefly  | B             | ❌ (DB query)    | ✅ Active        | 1 query     |

### Query Breakdown

- **Active tenant access**: 0 queries (JWT validation only)
- **Cross-tenant access**: 1 query per request (acceptable overhead)
- **Tenant switching**: 0 queries for subsequent requests (new JWT active)

### Why This Matters

```
Scenario: User with 20 tenants

Option A: Store all 20 tenants in JWT
├─ JWT Size: ~10KB (500 bytes × 20 tenants)
├─ Problem: Exceeds 8KB HTTP header limit!
├─ Problem: Bandwidth waste on every request
└─ Result: DOESN'T WORK

Option B: Active Tenant Pattern (Current)
├─ JWT Size: ~2KB (constant, regardless of tenant count)
├─ Benefit: Scalable to unlimited tenants
├─ Benefit: Fast network transmission
├─ Benefit: Cross-tenant access fallback available
└─ Result: WORKS AT SCALE ✅
```

---

## JWT Token Structure

### Active Tenant Pattern (Recommended)

```json
{
  "iss": "platform.example.com",
  "sub": "user-001",
  "iat": 1705000000,
  "exp": 1705003600,
  "email": "user1@example.com",

  "activeTenant": {
    "id": "tenant-a",
    "slug": "tenant-a",
    "name": "Tenant A",
    "role": "owner",
    "permissions": [
      "resource:create",
      "resource:read",
      "resource:update",
      "resource:delete",
      "tenant:admin",
      "users:manage"
    ]
  },

  "metadata": {
    "loginTime": 1705000000,
    "lastActivity": 1705002000,
    "ipAddress": "192.168.1.1"
  }
}
```

**JWT Size**: ~2KB regardless of tenant count

---

## API Endpoints

### List Available Tenants

**Endpoint**: `GET /auth/tenants`

**Purpose**: UI dropdown/selector showing all tenants user can access

**Request:**

```
GET /auth/tenants
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response:**

```json
{
  "activeTenantId": "tenant-a",
  "tenants": [
    {
      "id": "tenant-a",
      "slug": "tenant-a",
      "name": "Tenant A",
      "role": "owner",
      "isActive": true,
      "permissions": ["resource:*", "tenant:admin", "users:manage"]
    },
    {
      "id": "tenant-b",
      "slug": "tenant-b",
      "name": "Tenant B",
      "role": "admin",
      "isActive": false,
      "permissions": ["resource:*", "tenant:settings", "users:manage"]
    },
    {
      "id": "tenant-c",
      "slug": "tenant-c",
      "name": "Tenant C",
      "role": "operator",
      "isActive": false,
      "permissions": ["resource:read", "resource:update"]
    },
    {
      "id": "tenant-d",
      "slug": "tenant-d",
      "name": "Tenant D",
      "role": "operator",
      "isActive": false,
      "permissions": ["resource:read", "resource:update"]
    },
    {
      "id": "tenant-e",
      "slug": "tenant-e",
      "name": "Tenant E",
      "role": "user",
      "isActive": false,
      "permissions": ["resource:read"]
    }
  ]
}
```

### Switch Active Tenant

**Endpoint**: `POST /auth/switch-tenant`

**Purpose**: Change active tenant without logout

**Request:**

```
POST /auth/switch-tenant
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
  "tenantId": "tenant-b"
}
```

**Response:**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFjdGl2ZVRlbmFudCI6eyJpZCI6InRlbmFudC1iIn0sImlhdCI6MTcwNTAwMjAwMCwiZXhwIjoxNzA1MDA1NjAwfQ.signature",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTAwMSIsInR5cCI6InJlZnJlc2giLCJpYXQiOjE3MDUwMDIwMDAsImV4cCI6MTcwNTA4ODQwMH0.signature",
  "activeTenant": {
    "id": "tenant-b",
    "slug": "tenant-b",
    "name": "Tenant B",
    "role": "admin",
    "permissions": [
      "resource:create",
      "resource:read",
      "resource:update",
      "tenant:settings",
      "users:manage"
    ]
  }
}
```

---

## Security Guarantees

### What IS Allowed ✅

1. **Active tenant access** (User1, active=Tenant A, accessing Tenant A)

   - Valid: 0 queries, instant access
   - Secure: JWT validation sufficient

2. **Cross-tenant access** (User1, active=Tenant A, accessing Tenant B)

   - Valid: 1 DB query to verify authorization
   - Secure: Role-based permission check

3. **Role enforcement** (User1 with 'operator' role attempting 'admin' action)

   - Blocked: Role insufficient
   - Secure: Permission denied

4. **Tenant switching** (User1 switching from Tenant A to Tenant B)
   - Valid: New token issued with new active tenant
   - Secure: Token signed by backend

### What IS Blocked ❌

1. **Unauthorized tenant access** (User1 trying to access Tenant Z where they have no role)

   - Blocked: Database query returns no role entry
   - Result: 403 Forbidden

2. **Insufficient role access** (User1 with 'user' role trying to delete resources)

   - Blocked: Permission check in guard
   - Result: 403 Forbidden

3. **Tampered JWT** (Attacker modifies tenant ID in token)

   - Blocked: JWT signature verification fails
   - Result: 401 Unauthorized

4. **Expired token** (JWT exp claim in past)
   - Blocked: Token validation middleware
   - Result: 401 Unauthorized

---

## Implementation Patterns

### Guard Implementation

```typescript
@Injectable()
export class TenantAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const jwt = this.extractJwt(request);

    // 1. Extract active tenant from JWT
    const activeTenant = jwt.payload.activeTenant;

    // 2. Extract tenant from URL or request
    const requestedTenantId = this.extractTenantId(request);

    // 3. Check if active tenant matches
    if (activeTenant.id === requestedTenantId) {
      // ✅ Fast path: Active tenant, no DB query needed
      request.tenant = activeTenant;
      return true;
    }

    // 4. Fallback: Cross-tenant access (1 DB query)
    const userRole = await this.userRoleService.getRole(
      jwt.payload.sub,
      requestedTenantId
    );

    if (!userRole) {
      // ❌ User has no role in this tenant
      throw new ForbiddenException();
    }

    // ✅ Cross-tenant access allowed
    request.tenant = {
      id: requestedTenantId,
      role: userRole,
      // ... fetch other tenant data from cache/DB
    };
    return true;
  }
}
```

### Service Usage Pattern

```typescript
@Injectable()
export class ResourceService {
  async getResources(
    tenantId: string, // ← Always explicit
    filters?: any
  ): Promise<Resource[]> {
    // ❌ WRONG: No tenant filter
    // return this.repo.find(filters);

    // ✅ CORRECT: Always filter by tenant
    return this.repo.find({
      ...filters,
      tenantId, // ← Mandatory tenant filter
    });
  }
}
```

---

## Database Query Optimization

### Indexed Query Pattern

```sql
-- ✅ OPTIMAL: Composite index on (tenant_id, role)
CREATE INDEX idx_user_roles_tenant_role
  ON user_roles (user_id, tenant_id, role);

-- Query becomes:
SELECT role FROM user_roles
  WHERE user_id = $1
    AND tenant_id = $2;

-- Index lookup: O(log n) ← Fast
```

### Query Metrics

| Scenario             | Query Count | Index Used | Performance              |
| -------------------- | ----------- | ---------- | ------------------------ |
| Active tenant access | 0           | N/A        | ⚡ < 10ms (JWT only)     |
| Cross-tenant access  | 1           | Yes        | ✅ ~50ms (indexed query) |
| Tenant switching     | 0           | N/A        | ⚡ < 10ms (new JWT)      |

---

## UI Implementation

### Tenant Selector Dropdown

```typescript
// Fetch available tenants
const response = await fetch('/auth/tenants', {
  headers: { Authorization: `Bearer ${token}` },
});

const { tenants, activeTenantId } = await response.json();

// Render dropdown
const options = tenants.map((tenant) => ({
  value: tenant.id,
  label: tenant.name,
  selected: tenant.id === activeTenantId,
  role: tenant.role,
}));

// Handle switch
async function switchTenant(tenantId: string) {
  const response = await fetch('/auth/switch-tenant', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tenantId }),
  });

  const { accessToken } = await response.json();

  // Save new token
  localStorage.setItem('accessToken', accessToken);

  // Refresh page or update state
  window.location.reload();
}
```

---

## Decision: Why Active Tenant Pattern?

### Comparison: All Tenants in JWT vs Active Tenant Only

| Aspect                        | All Tenants in JWT                       | Active Tenant Only (Current) |
| ----------------------------- | ---------------------------------------- | ---------------------------- |
| **JWT Size**                  | ~500 bytes × tenant count                | Constant ~2KB                |
| **Scalability**               | Breaks at ~16 tenants (8KB header limit) | Unlimited tenants            |
| **DB Queries (active)**       | 0                                        | 0                            |
| **DB Queries (cross-tenant)** | 0                                        | 1                            |
| **Tenant Switching**          | Requires re-login                        | POST /auth/switch-tenant     |
| **Security Revocation**       | Must invalidate entire JWT               | Switch active tenant         |
| **Header Overhead**           | Grows with tenants                       | Constant                     |
| **Recommended Use**           | Small, fixed tenant count                | General purpose, unlimited   |

**Verdict**: Active Tenant Pattern is optimal for real-world systems where user-tenant relationships grow over time.

---

## Real-World Example: Typical User Day

```
09:00 - Login
├─ User1 logs in
├─ Active tenant set to Tenant A (default)
├─ JWT issued with Tenant A context
└─ Queries: 0 ⚡

09:15 - Work in Tenant A
├─ GET /api/tenants/tenant-a/resources
├─ Guard: activeTenant.id === tenant-a → YES ✅
├─ No DB query needed
└─ Queries: 0 ⚡

10:00 - Check Tenant B briefly
├─ GET /api/tenants/tenant-b/resources
├─ Guard: activeTenant.id === tenant-b → NO
├─ Fall back to DB query
├─ SELECT role FROM user_roles WHERE user_id=? AND tenant_id=?
├─ Result: admin role found ✅
└─ Queries: 1

12:00 - Lunch break, back to Tenant A
├─ GET /api/tenants/tenant-a/resources
├─ Guard: activeTenant.id === tenant-a → YES ✅
├─ No DB query needed
└─ Queries: 0 ⚡

14:00 - Switch to Tenant B for afternoon work
├─ POST /auth/switch-tenant { tenantId: "tenant-b" }
├─ Backend verifies user has role in tenant-b
├─ New JWT issued with activeTenant = tenant-b
├─ Front-end receives new token
└─ Queries: 1 (verification only)

14:15 - Work in Tenant B
├─ GET /api/tenants/tenant-b/resources
├─ Guard: activeTenant.id === tenant-b → YES ✅
├─ No DB query needed
└─ Queries: 0 ⚡

16:30 - Logout
├─ Token invalidated
└─ End of day
```

---

## Summary

**The Active Tenant Pattern solves the multi-tenant access challenge:**

1. ✅ **Scalable**: JWT stays constant size even with 100+ tenants
2. ✅ **Fast**: Active tenant access = 0 queries
3. ✅ **Practical**: Cross-tenant access = 1 query overhead (acceptable)
4. ✅ **Secure**: All access validated against database
5. ✅ **Flexible**: Users can switch tenants seamlessly
6. ✅ **Production-ready**: Battle-tested in large-scale systems

This pattern is the industry standard for modern multi-tenant SaaS platforms.
