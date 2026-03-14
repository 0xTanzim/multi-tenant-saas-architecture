# Multi-Tenant Isolation

Comprehensive guide to preventing tenant data leakage in multi-tenant SaaS systems. Covers threat models, attack vectors, isolation enforcement at every layer, and defense-in-depth strategies.

---

## Table of Contents

- [Threat Model](#threat-model)
- [Attack Vectors](#attack-vectors)
- [API Layer Isolation](#api-layer-isolation)
- [Service Layer Isolation](#service-layer-isolation)
- [Repository/Database Layer Isolation](#repositorydatabase-layer-isolation)
- [Cache Layer Isolation](#cache-layer-isolation)
- [Logging and Audit Isolation](#logging-and-audit-isolation)
- [Defense-in-Depth Checklist](#defense-in-depth-checklist)
- [Testing Tenant Isolation](#testing-tenant-isolation)
- [Incident Response](#incident-response)

---

## Threat Model

### **Who Are the Attackers?**

1. **Malicious User (Same Tenant)**

   - Objective: Access admin functions beyond their role
   - Risk: Cross-role privilege escalation within tenant
   - Mitigation: RBAC, permission checks

2. **Tenant A User (Attacking Tenant B)**

   - Objective: Access Tenant B's data via API manipulation
   - Risk: **CRITICAL** — Complete tenant data breach
   - Mitigation: Tenant_id validation, query filtering

3. **Compromised API Key or Token**

   - Objective: Access data with stolen credentials
   - Risk: HIGH — Attacker can impersonate legitimate user
   - Mitigation: Token expiration, rate limiting, monitoring

4. **Malicious Backend Developer**

   - Objective: Query data across all tenants
   - Risk: **CRITICAL** — Complete database breach
   - Mitigation: Code review, database encryption, audit logs

5. **Network Attacker (MITM)**
   - Objective: Intercept credentials or tokens
   - Risk: HIGH — Session hijacking
   - Mitigation: HTTPS, secure cookies, token rotation

### **Attack Success Criteria**

An attack is successful if:

```
✓ Attacker can read data from another tenant
✓ Attacker can modify another tenant's data
✓ Attacker can delete another tenant's data
✓ Attacker can escalate their role beyond assignment
✓ Attacker can access tenant configuration
✓ Attacker can export or exfiltrate data
```

---

## Attack Vectors

### **Vector 1: Direct Parameter Manipulation**

```
Attacker URL: GET /api/tenants/tenant-B-id/users
Expected: 403 Forbidden (user not in tenant B)

❌ Vulnerable Implementation:
  SELECT * FROM users WHERE tenant_id = $1;
  (No validation that user belongs to $1)

✅ Secure Implementation:
  1. Extract user's tenant_id from JWT
  2. Validate JWT tenant_id == request tenant_id
  3. Query with both filters
```

### **Vector 2: Token Manipulation**

```
Attacker modifies JWT:
  Original:  { "sub": "user-123", "tenant_id": "tenant-A", ... }
  Modified:  { "sub": "user-123", "tenant_id": "tenant-B", ... }

❌ Vulnerable: Backend trusts tenant_id in token without verification
✅ Secure: Backend verifies token signature (cryptographic proof)
```

### **Vector 3: Cache Poisoning**

```
Cache Key: "perm:user-123:tenant-A"
Attacker triggers cache build, then modifies cache lookup

❌ Vulnerable: Cache key doesn't include expiration/hash
✅ Secure: Cache key includes hash, TTL auto-expires
```

### **Vector 4: N+1 Query with Tenant Crossing**

```
Query: SELECT * FROM users;
Expected: Only current tenant users

❌ Vulnerable:
  for (user of users) {
    user.orders = db.query("SELECT * FROM orders WHERE user_id = ?", user.id);
    // May fetch orders from other tenants if relationship not filtered
  }

✅ Secure:
  SELECT u.*, o.* FROM users u
  LEFT JOIN orders o ON o.user_id = u.id
  WHERE u.tenant_id = ?;
```

### **Vector 5: SQL Injection**

```
Input: email = "admin' OR '1'='1"
Query: SELECT * FROM users WHERE email = ? AND tenant_id = ?

❌ Vulnerable (without parameterization):
  SELECT * FROM users WHERE email = '${email}' AND tenant_id = '${tenantId}';

✅ Secure (parameterized query):
  SELECT * FROM users WHERE email = $1 AND tenant_id = $2;
  [email, tenantId]
```

### **Vector 6: Batch Operations Without Tenant Filtering**

```
Endpoint: DELETE /api/users/:id

❌ Vulnerable:
  const user = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  await db.query("DELETE FROM users WHERE id = $1", [id]);
  // No check that user belongs to current tenant

✅ Secure:
  const user = await db.query(
    "SELECT * FROM users WHERE id = $1 AND tenant_id = $2",
    [id, tenantId]
  );
  if (!user) throw new ForbiddenException();
  await db.query(
    "DELETE FROM users WHERE id = $1 AND tenant_id = $2",
    [id, tenantId]
  );
```

### **Vector 7: Event/Message Queue Bypassing Tenant Context**

```
❌ Vulnerable:
  EventEmitter.emit('user:created', { userId: '123' });
  // Listener processes event without tenant context
  // May access data across tenants

✅ Secure:
  EventEmitter.emit('user:created', {
    userId: '123',
    tenantId: 'tenant-A',  // ← Include tenant in event
  });
  // Listener extracts tenantId and scopes all queries
```

---

## API Layer Isolation

### **Layer 1: Token Validation**

```typescript
// JwtAuthGuard: Validates token signature
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err, user, info) {
    if (err || !user) {
      throw new UnauthorizedException('Invalid token');
    }
    // At this point, token is cryptographically verified
    // tenant_id is trusted from token
    return user;
  }
}
```

**Defense**: Prevents token spoofing (attacker can't forge tenant_id).

### **Layer 2: Tenant Context Extraction**

```typescript
// TenantGuard: Extracts and validates tenant context
@Injectable()
export class TenantGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Extract from JWT (source of truth)
    const tenantId = request.user?.tenant_id;
    if (!tenantId) {
      throw new BadRequestException('Tenant context missing');
    }

    // Verify user belongs to this tenant
    const hasAccess = await this.userTenantService.userBelongsToTenant(
      request.user.id,
      tenantId
    );
    if (!hasAccess) {
      throw new ForbiddenException('User does not belong to this tenant');
    }

    // Attach to request for downstream use
    request.tenantId = tenantId;
    return true;
  }
}
```

**Defense**: Ensures tenant_id is valid and user has access.

### **Layer 3: Request Parameter Validation**

```typescript
@Controller('tenants')
export class TenantsController {
  @Get(':tenantId/users')
  async getUsers(
    @Param('tenantId') paramTenantId: string,
    @Req() req: Request
  ) {
    // Extract from request context (already validated)
    const contextTenantId = req.tenantId;

    // If request includes tenant ID, must match context
    if (paramTenantId && paramTenantId !== contextTenantId) {
      throw new ForbiddenException('Tenant mismatch');
    }

    // Service call with tenant context
    return this.usersService.getUsersByTenant(contextTenantId);
  }
}
```

**Defense**: Prevents parameter manipulation attacks.

### **Layer 4: Authorization Checks**

```typescript
@Post('users')
@RequirePermissions('tenant.users.create')
async createUser(
  @Body() dto: CreateUserDto,
  @Req() req: Request
) {
  // At this point:
  // 1. Token validated (JwtAuthGuard)
  // 2. Tenant context verified (TenantGuard)
  // 3. User permission checked (PermissionGuard)

  return this.usersService.createUser(req.tenantId, dto);
}
```

**Defense**: Ensures user has permission for the action.

---

## Service Layer Isolation

### **Pattern 1: Tenant-Scoped Service Methods**

```typescript
@Injectable()
export class UsersService {
  // ✅ Good: Tenant parameter is explicit
  async getUsersByTenant(tenantId: string): Promise<User[]> {
    return this.usersRepository.findByTenant(tenantId);
  }

  // ✅ Better: Tenant parameter is required first
  async createUserInTenant(
    tenantId: string,
    dto: CreateUserDto
  ): Promise<User> {
    // Validation: tenantId cannot be null or undefined
    if (!tenantId) {
      throw new Error('Tenant context required');
    }

    // Pass to repository with explicit tenant_id
    return this.usersRepository.create(tenantId, dto);
  }

  // ❌ Bad: No tenant parameter (unsafe)
  async getUser(userId: string): Promise<User> {
    return this.usersRepository.findById(userId);
    // Caller could pass user from another tenant!
  }
}
```

**Rule**: Every service method that accesses tenant data must have `tenantId` as the first parameter.

### **Pattern 2: Validation Before Action**

```typescript
@Injectable()
export class OrdersService {
  async updateOrder(
    tenantId: string,
    orderId: string,
    updateDto: UpdateOrderDto
  ): Promise<Order> {
    // 1. Fetch order (with tenant filter)
    const order = await this.ordersRepository.findById(orderId, tenantId);

    // 2. Verify it exists and belongs to tenant
    if (!order) {
      throw new NotFoundException('Order not found');
      // This could mean: doesn't exist OR belongs to another tenant
      // Return same error message for both (don't leak existence)
    }

    // 3. Check user has permission
    const hasPermission = await this.permissionService.hasPermission(
      userId,
      tenantId,
      'orders.update'
    );
    if (!hasPermission) {
      throw new ForbiddenException('No permission to update orders');
    }

    // 4. Update order (with tenant filter)
    return this.ordersRepository.update(orderId, tenantId, updateDto);
  }
}
```

**Defense**: Prevents "confused deputy" attacks (service performing actions it shouldn't).

### **Pattern 3: Delegation Between Services**

```typescript
@Injectable()
export class OrdersService {
  constructor(private itemsService: ItemsService) {}

  async getOrderWithItems(
    tenantId: string,
    orderId: string
  ): Promise<OrderWithItems> {
    // 1. Fetch order
    const order = await this.ordersRepository.findById(orderId, tenantId);
    if (!order) throw new NotFoundException();

    // 2. Fetch items (PASS tenantId to delegate service)
    const items = await this.itemsService.getItemsByOrder(tenantId, orderId);
    // ✅ Critical: ItemsService receives tenantId
    // This ensures all queries are tenant-scoped

    return { order, items };
  }
}
```

**Defense**: Prevents data leakage when services delegate to other services.

---

## Repository/Database Layer Isolation

### **Pattern 1: Parameterized Queries with Tenant Filter**

```typescript
// ✅ Secure: Parameterized query with tenant_id always included
async findByEmail(tenantId: string, email: string): Promise<User | null> {
  return this.db.query(
    'SELECT * FROM users WHERE tenant_id = $1 AND email = $2',
    [tenantId, email]
  );
  // Two params, no string interpolation
  // tenant_id is always part of the WHERE clause
}

// ❌ Vulnerable: String interpolation (SQL injection risk)
async findByEmail(tenantId: string, email: string): Promise<User | null> {
  return this.db.query(
    `SELECT * FROM users WHERE tenant_id = '${tenantId}' AND email = '${email}'`
  );
}

// ❌ Vulnerable: tenant_id only in WHERE, not in WHERE
async findByEmail(email: string): Promise<User | null> {
  return this.db.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );
  // Caller could receive user from any tenant
}
```

### **Pattern 2: Composite Indexes for Performance**

```sql
-- ❌ Slow: Separate indexes
CREATE INDEX idx_users_id ON users(id);
CREATE INDEX idx_users_tenant_id ON users(tenant_id);

-- ✅ Fast: Composite index
CREATE INDEX idx_users_tenant_id_id ON users(tenant_id, id);
-- Query planner uses this index for: WHERE tenant_id = ? AND id = ?

-- Most important: Unique constraint for isolation
CREATE UNIQUE INDEX idx_user_tenant ON users(id, tenant_id);
-- Guarantees: (user_id, tenant_id) combination is unique
-- Query: SELECT * FROM users WHERE id = ? AND tenant_id = ?
-- Will return at most 1 row (cannot leak data even if query is malformed)
```

### **Pattern 3: Joins with Tenant Filtering**

```typescript
// ❌ Vulnerable: Missing tenant filter on joined table
async getOrdersWithCustomer(tenantId: string): Promise<OrderWithCustomer[]> {
  return this.db.query(
    `SELECT o.*, c.* FROM orders o
     JOIN customers c ON o.customer_id = c.id
     WHERE o.tenant_id = $1`,
    [tenantId]
  );
  // BUG: customer table not filtered by tenant_id
  // Could join with customer from another tenant
}

// ✅ Secure: Tenant filter on all tables
async getOrdersWithCustomer(tenantId: string): Promise<OrderWithCustomer[]> {
  return this.db.query(
    `SELECT o.*, c.* FROM orders o
     JOIN customers c ON o.customer_id = c.id
       AND c.tenant_id = $1  // ← CRITICAL: Tenant filter on JOIN
     WHERE o.tenant_id = $1`,
    [tenantId]
  );
}
```

### **Pattern 4: Soft Deletes with Tenant Filtering**

```typescript
// ❌ Vulnerable: Soft delete filter missing tenant_id
async findActive(tenantId: string): Promise<User[]> {
  return this.db.query(
    'SELECT * FROM users WHERE deleted_at IS NULL',
    []
  );
  // Returns all active users across all tenants!
}

// ✅ Secure: Both deleted_at AND tenant_id filters
async findActive(tenantId: string): Promise<User[]> {
  return this.db.query(
    'SELECT * FROM users WHERE deleted_at IS NULL AND tenant_id = $1',
    [tenantId]
  );
}

// ✅ Better: Tenant filter should be first (helps query planner)
async findActive(tenantId: string): Promise<User[]> {
  return this.db.query(
    'SELECT * FROM users WHERE tenant_id = $1 AND deleted_at IS NULL',
    [tenantId]
  );
}
```

---

## Cache Layer Isolation

### **Tenant-Scoped Cache Keys**

```typescript
// ❌ Vulnerable: No tenant in cache key
const cacheKey = `user:${userId}`;
// User 123 in tenant A and tenant B would share cache!

// ✅ Secure: Tenant in cache key
const cacheKey = `tenant:${tenantId}:user:${userId}`;
// Different keys for same user in different tenants

// ✅ Better: Include TTL hash in key
const cacheKey = `perm:v1:${tenantId}:${userId}:${hashOfRoles}`;
// Cache invalidates if roles change (hash differs)
```

### **Cache Invalidation Strategy**

```typescript
// On role assignment change:
async assignRole(userId: string, tenantId: string, roleId: string) {
  // 1. Update database
  await this.db.query(
    'INSERT INTO user_roles (user_id, tenant_id, role_id) VALUES ($1, $2, $3)',
    [userId, tenantId, roleId]
  );

  // 2. Invalidate permission cache for this user + tenant
  const cacheKey = `perm:${tenantId}:${userId}`;
  await this.cache.delete(cacheKey);

  // 3. Emit event (for other services)
  this.eventBus.emit('role:assigned', {
    userId,
    tenantId,
    roleId,
  });

  // 4. Subsequent request will rebuild cache
}
```

---

## Logging and Audit Isolation

### **Tenant-Scoped Audit Logs**

```typescript
// ❌ Vulnerable: Logs from all tenants mixed
async auditLog(action: string, data: any) {
  logger.info(`Action: ${action}`, { data });
  // Log could expose another tenant's data
}

// ✅ Secure: Tenant context in all logs
async auditLog(tenantId: string, action: string, userId: string) {
  logger.info(`Action: ${action}`, {
    tenantId,          // Always include
    userId,
    timestamp: Date.now(),
    // Do NOT include sensitive data
  });
}

// ✅ Better: Use middleware to auto-inject tenant
@Injectable()
export class AuditLoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest();
    const { tenantId, user } = req;

    return next.handle().pipe(
      tap(() => {
        this.logger.info('Request completed', {
          tenantId,        // Automatically included
          userId: user?.id,
          path: req.path,
          method: req.method,
        });
      })
    );
  }
}
```

### **Sensitive Data Masking**

```typescript
// ❌ Vulnerable: Full email exposed in logs
logger.info('User login', { email: 'customer@company.com', tenantId });

// ✅ Secure: Masked email
logger.info('User login', {
  email_masked: maskEmail('customer@company.com'), // c****@c******.com
  tenantId,
});

// ✅ Better: Hash instead of expose
logger.info('User login', {
  user_hash: hash('customer@company.com'),
  tenantId,
});
// Only use hash for correlation, never expose original
```

---

## Defense-in-Depth Checklist

### **API Layer**

- [ ] JwtAuthGuard validates token signature
- [ ] TenantGuard validates user belongs to tenant
- [ ] All endpoints validate tenant_id parameter matches JWT
- [ ] All responses filtered by tenant_id
- [ ] No cross-tenant parameter passing
- [ ] Rate limiting per tenant
- [ ] Request logging includes tenant_id

### **Service Layer**

- [ ] All methods accept tenantId as first parameter
- [ ] Tenant_id always required (no null checks that skip)
- [ ] Data fetches include tenant filter
- [ ] Cross-service calls pass tenant context
- [ ] No global data access methods
- [ ] Delegation to other services includes tenant
- [ ] Error messages don't leak data (e.g., "not found" vs "forbidden")

### **Repository/Database Layer**

- [ ] All queries include WHERE tenant_id = ?
- [ ] Parameterized queries (no string interpolation)
- [ ] Composite indexes on (tenant_id, resource_id)
- [ ] Foreign keys enforce tenant_id matching
- [ ] Soft deletes include tenant in WHERE clause
- [ ] Joins include tenant filter on all tables
- [ ] Migrations tested for isolation

### **Cache Layer**

- [ ] Cache keys include tenant_id
- [ ] Cache TTL set (prevents stale data)
- [ ] Cache invalidated on role changes
- [ ] Cache invalidated on user removal from tenant
- [ ] Separate cache stores per environment (no prod/staging mix)

### **Logging Layer**

- [ ] All logs include tenant_id
- [ ] Sensitive data masked or hashed
- [ ] Logs stored per-tenant (or at least queryable)
- [ ] Logs include user_id and action
- [ ] Logs preserved for audit trail (configurable retention)
- [ ] Log access controlled by role

### **Testing Layer**

- [ ] Unit tests verify tenant filtering
- [ ] Integration tests verify cross-tenant access is denied
- [ ] Scenario tests for multi-tenant data mixing
- [ ] Negative tests for "forbidden" scenarios
- [ ] Permission matrix tests (who can access what)
- [ ] Edge cases tested (null tenants, invalid tenants)

---

## Testing Tenant Isolation

### **Automated Test Suite**

```typescript
describe('Tenant Isolation', () => {
  let tenantA: Tenant;
  let tenantB: Tenant;
  let userA: User;
  let userB: User;

  beforeAll(async () => {
    tenantA = await createTenant('acme-corp');
    tenantB = await createTenant('startup-xyz');
    userA = await createUser(tenantA.id, 'alice@acme.com');
    userB = await createUser(tenantB.id, 'bob@startup.xyz');
  });

  describe('API Parameter Validation', () => {
    it('should reject cross-tenant data access', async () => {
      // User A tries to access User B's tenant
      const response = await request(app.getHttpServer())
        .get(`/api/tenants/${tenantB.id}/users`)
        .set('Authorization', `Bearer ${userA.accessToken}`);

      expect(response.status).toBe(403);
      expect(response.body.data).toBeUndefined();
    });

    it('should allow same-tenant access', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/tenants/${tenantA.id}/users`)
        .set('Authorization', `Bearer ${userA.accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data[0].tenant_id).toBe(tenantA.id);
    });
  });

  describe('Query Filtering', () => {
    it('should not leak data in pagination', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/users?limit=1000`)
        .set('Authorization', `Bearer ${userA.accessToken}`);

      const users = response.body.data;
      const hasCrossTenantUsers = users.some((u) => u.tenant_id !== tenantA.id);

      expect(hasCrossTenantUsers).toBe(false);
    });
  });

  describe('Cache Isolation', () => {
    it('should not share cache across tenants', async () => {
      // Fetch as user A
      await request(app.getHttpServer())
        .get(`/api/users`)
        .set('Authorization', `Bearer ${userA.accessToken}`);

      // Fetch as user B (should not use A's cache)
      const response = await request(app.getHttpServer())
        .get(`/api/users`)
        .set('Authorization', `Bearer ${userB.accessToken}`);

      expect(response.body.data[0].tenant_id).toBe(tenantB.id);
    });
  });
});
```

---

## Incident Response

### **Detecting a Breach**

Indicators of potential tenant isolation breach:

```
🚨 Red Flags:
  - User accessing data from another tenant
  - Unexpected queries in logs crossing tenant boundaries
  - Cache hits with mismatched tenant_id
  - Permissions leaking across tenants
  - Unusual bulk data exports
  - Multiple tenants reporting "seeing other data"
```

### **Immediate Response**

```
1. ISOLATE: Take affected service offline
2. VERIFY: Check logs for scope of breach
3. NOTIFY: Inform affected tenants
4. PRESERVE: Archive logs and data
5. INVESTIGATE: Root cause analysis
6. PATCH: Deploy fix
7. TEST: Verify isolation with automated tests
8. RESTORE: Bring service back online
9. AUDIT: Scan for residual data leakage
10. COMMUNICATE: Post-mortem report to stakeholders
```

---

## Summary

Multi-tenant isolation requires defense-in-depth:

1. ✓ **API Layer**: Token validation, tenant context extraction, parameter validation
2. ✓ **Service Layer**: Tenant-scoped methods, explicit parameters, validation before action
3. ✓ **Database Layer**: Parameterized queries, composite indexes, tenant filters on all operations
4. ✓ **Cache Layer**: Tenant-scoped keys, TTL, invalidation on changes
5. ✓ **Logging Layer**: Tenant context in all logs, sensitive data masking
6. ✓ **Testing Layer**: Automated tests for cross-tenant access attempts

**Golden Rule**: If tenant_id is not explicit in every query, the system is vulnerable.

The next document (SECURITY_BEST_PRACTICES.md) covers complementary security practices: data validation, audit logging, secrets management, and common vulnerabilities.
