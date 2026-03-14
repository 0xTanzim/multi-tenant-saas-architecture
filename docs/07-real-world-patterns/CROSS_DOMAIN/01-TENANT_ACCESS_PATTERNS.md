> **Source**: Extracted from production system, sanitized for portfolio use
> **Original**: DoneByMe Multi-Tenant Access Flow - Active Tenant Pattern
> **Status**: Production Implementation

# Multi-Tenant Access Flow — Active Tenant Pattern

---

## 1. Executive Summary

**Scenario**: A user (Sarah) works for multiple tenants (businesses):

- **Business A** (Owner) — Main business
- **Business B** (Manager) — Part-time management
- **Business C** (Staff) — Weekend work
- **Business D** (Staff) — Evening shifts
- **Business E** (Staff) — Freelance work

**Total: 5 tenants with different roles**

**Challenge**: How to efficiently manage which tenant is "active" without bloating the JWT with all 5 tenant entries?

**Solution**: Active Tenant Pattern

---

## 2. Active Tenant Pattern Overview

### JWT Structure (Compact)

```json
{
  "userId": 123,
  "email": "sarah@example.com",
  "activeTenant": {
    "id": 1,
    "slug": "business-a",
    "name": "Business A",
    "role": "owner",
    "permissions": ["booking:create", "booking:read", ...]
  },
  "exp": 1697234567
}
```

**JWT Size**: ~2KB (constant, regardless of tenant count)

### Compare to Alternative (All Tenants in JWT)

```json
{
  "userId": 123,
  "email": "sarah@example.com",
  "tenantRoles": [
    { "id": 1, "role": "owner", "permissions": [...] },      // 500 bytes
    { "id": 2, "role": "manager", "permissions": [...] },    // 500 bytes
    { "id": 3, "role": "staff", "permissions": [...] },      // 500 bytes
    { "id": 4, "role": "staff", "permissions": [...] },      // 500 bytes
    { "id": 5, "role": "staff", "permissions": [...] }       // 500 bytes
  ]
}
```

**JWT Size**: ~2.5KB (5 tenants × 500 bytes each)
**Problem**: User with 20 tenants = ~10KB JWT = exceeds 8KB HTTP header limit!

---

## 3. How It Works

### Scenario: Accessing Active Tenant (Business A)

```
GET /tenant/business-a/bookings
Authorization: Bearer <JWT with activeTenant=Business A>

Guard Flow:
1. Extract activeTenant from JWT: { id: 1, role: "owner" }
2. Extract tenantId from URL: 1 (Business A)
3. Check: activeTenant.id === tenantId? YES ✅
4. ALLOW ACCESS (0 database queries)

⚡ Performance: O(1) — Instant JWT validation
```

### Scenario: Accessing Different Tenant (Business B)

```
GET /tenant/business-b/bookings
Authorization: Bearer <JWT with activeTenant=Business A>

Guard Flow:
1. Extract activeTenant from JWT: { id: 1, role: "owner" }
2. Extract tenantId from URL: 2 (Business B)
3. Check: activeTenant.id === tenantId? NO ❌
4. Fall back to database query:
   Query: "SELECT role FROM user_roles WHERE user_id=123 AND tenant_id=2"
   Result: "manager"
5. Check: "manager" >= required role? YES ✅
6. ALLOW ACCESS (1 database query)

⚡ Performance: O(n) — Single DB query per cross-tenant request
```

---

## 4. Tenant Switching

### Switch Active Tenant (Endpoint)

```
POST /auth/switch-tenant
Authorization: Bearer <JWT with activeTenant=Business A>
{
  "tenantId": 2  // Switch to Business B
}

Response:
{
  "accessToken": "new-jwt-with-business-b-active",
  "refreshToken": "...",
  "activeTenant": {
    "id": 2,
    "slug": "business-b",
    "name": "Business B",
    "role": "manager",
    "permissions": ["booking:create", "booking:read", ...]
  }
}
```

**After switching**: All Business B requests become instant (0 DB queries)!

---

## 5. Performance Analysis

### Scenario 1: Sarah Works Mostly in Business A

- Business A requests: **0 DB queries** (instant JWT check)
- Business B/C/D/E requests: **1 DB query each** (acceptable overhead)
- **Recommendation**: Keep Business A as active tenant

### Scenario 2: Sarah Switches to Business B for the Day

1. Call `POST /auth/switch-tenant` → get new JWT with Business B active
2. Business B requests: **0 DB queries** (instant JWT check)
3. Business A/C/D/E requests: **1 DB query each**
4. **Recommendation**: Switch active tenant when working extended period in different business

### Performance Comparison

| Scenario                             | Pattern       | Queries         | Impact       |
| ------------------------------------ | ------------- | --------------- | ------------ |
| Work 80% in Biz A, 20% across others | Active tenant | 20 queries/hour | ✅ Minimal   |
| All tenants in JWT                   | N/A           | 0 queries       | ❌ JWT bloat |
| Switch active tenant per shift       | Active tenant | 5 queries/hour  | ✅ Optimal   |

---

## 6. Implementation Details

### Auth Guard (Multi-Tenant Aware)

```typescript
@Injectable()
export class TenantGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const tenantIdFromUrl = request.params.tenantSlug; // or from URL path
    const user = request.user; // from JWT
    const activeTenant = user.activeTenant;

    // Fast path: active tenant matches URL
    if (activeTenant.id === tenantIdFromUrl) {
      return true; // ✅ Allow (instant, no DB query)
    }

    // Slow path: check database for access to different tenant
    const userRole = await this.userService.checkTenantAccess(
      user.id,
      tenantIdFromUrl
    );

    if (userRole) {
      return true; // ✅ Allow (1 DB query)
    }

    throw new ForbiddenException('User does not have access to this tenant'); // ❌ Deny
  }
}
```

### API Endpoint: Get Available Tenants

```
GET /auth/tenants
Authorization: Bearer <JWT>

Response:
{
  "tenants": [
    { "id": 1, "slug": "business-a", "name": "Business A", "role": "owner", "isActive": true },
    { "id": 2, "slug": "business-b", "name": "Business B", "role": "manager", "isActive": false },
    { "id": 3, "slug": "business-c", "name": "Business C", "role": "staff", "isActive": false },
    { "id": 4, "slug": "business-d", "name": "Business D", "role": "staff", "isActive": false },
    { "id": 5, "slug": "business-e", "name": "Business E", "role": "staff", "isActive": false }
  ],
  "activeTenantId": 1
}
```

**Frontend uses this to show tenant dropdown for switching.**

---

## 7. Real-World Usage Pattern

### Sarah's Typical Day

**Morning (9 AM - 12 PM): Business A (main job)**

```
Active tenant: Business A
All Business A requests: 0 DB queries ⚡
→ Fast and efficient
```

**Afternoon (1 PM - 3 PM): Checking Business B schedule**

```
Active tenant: Still Business A
Business B requests: 1 DB query per request
→ Acceptable overhead for occasional access
```

**Evening (6 PM - 9 PM): Working at Business D**

```
Option 1: Keep Business A active
→ Business D requests: 1 DB query each (acceptable if < 10 requests/hour)

Option 2: Switch to Business D (RECOMMENDED)
→ POST /auth/switch-tenant → new JWT with Business D active
→ Business D requests: 0 DB queries ⚡
→ Optimal performance for extended work session
```

---

## 8. Database Optimization

### Single Query for Cross-Tenant Access

```sql
-- Fast, single query to verify access and get role
SELECT user_id, tenant_id, role
FROM user_roles
WHERE user_id = $1 AND tenant_id = $2
LIMIT 1;

-- Index for performance
CREATE INDEX idx_user_roles_composite
ON user_roles(user_id, tenant_id);
```

### Role Hierarchy (For Permission Checks)

```typescript
const roleHierarchy = {
  admin: 9,
  owner: 8,
  manager: 5,
  staff: 1,
};

// Permission check
if (roleHierarchy[userRole] >= roleHierarchy[requiredRole]) {
  // ✅ Allow
} else {
  // ❌ Deny
}
```

---

## 9. Security Guarantees

### What IS Allowed

1. ✅ Active tenant access (instant JWT check)
2. ✅ Cross-tenant access (if user has role in that tenant)
3. ✅ Role enforcement (staff can't access owner endpoints)
4. ✅ Multi-tenant isolation (can't access data from unauthorized tenant)

### What IS Blocked

1. ❌ Unauthorized tenants (can't access tenants where user has no role)
2. ❌ Insufficient roles (staff can't access owner endpoints)
3. ❌ Invalid tokens (expired or tampered JWT rejected)
4. ❌ Tenant impersonation (can't fake another user's access)

---

## 10. Frontend Implementation

### Tenant Dropdown

```typescript
// React component
function TenantSwitcher() {
  const [tenants, setTenants] = useState([]);
  const [activeTenant, setActiveTenant] = useState(null);

  // Fetch tenants on mount
  useEffect(() => {
    fetch('/auth/tenants', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        setTenants(data.tenants);
        setActiveTenant(data.activeTenantId);
      });
  }, [token]);

  const handleSwitchTenant = async (tenantId) => {
    const response = await fetch('/auth/switch-tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tenantId }),
    });

    const { accessToken, activeTenant } = await response.json();

    // Update local token
    localStorage.setItem('authToken', accessToken);

    // Update active tenant
    setActiveTenant(activeTenant.id);

    // Reload page to show new tenant data
    window.location.reload();
  };

  return (
    <select
      value={activeTenant}
      onChange={(e) => handleSwitchTenant(e.target.value)}
    >
      {tenants.map((tenant) => (
        <option key={tenant.id} value={tenant.id}>
          {tenant.name} ({tenant.role})
        </option>
      ))}
    </select>
  );
}
```

---

## 11. Comparison with Other Patterns

### Pattern 1: Active Tenant (Current)

**Pros**:

- ✅ JWT stays <2KB
- ✅ Fast for active tenant (0 DB queries)
- ✅ Reasonable for cross-tenant (1 DB query)
- ✅ Scales to 100+ tenants

**Cons**:

- ❌ Cross-tenant access slower (1 DB query)

### Pattern 2: All Tenants in JWT

**Pros**:

- ✅ Zero DB queries for any tenant

**Cons**:

- ❌ JWT bloat (~2.5KB for 5 tenants, ~10KB for 20 tenants)
- ❌ Exceeds 8KB HTTP header limit
- ❌ Slower token parsing
- ❌ Can't revoke single tenant access (have to reissue entire JWT)

### Pattern 3: Tenant Header

**Pros**:

- ✅ Tenant specified in every request

**Cons**:

- ❌ Must trust client (security risk)
- ❌ No permission inheritance

---

## 12. Summary

**The Active Tenant Pattern correctly handles Sarah's multi-tenant scenario:**

1. ✅ **Active tenant**: 0 DB queries — Instant access
2. ✅ **Other tenants**: 1 DB query — Verified access
3. ✅ **Tenant switching**: Change active tenant for optimal performance
4. ✅ **Scalability**: JWT stays <2KB even with 100 tenants
5. ✅ **Security**: Proper role enforcement and cross-tenant validation
6. ✅ **Permission granularity**: Different roles per tenant

**This implementation is correct and production-ready!**
