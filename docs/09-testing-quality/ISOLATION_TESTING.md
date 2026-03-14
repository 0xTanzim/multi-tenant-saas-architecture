# Isolation Testing: Proving Tenant Data Never Leaks

## Overview

Tenant isolation is the most critical security requirement in multi-tenant systems. This document provides comprehensive testing patterns to **prove that tenant data never leaks** to unauthorized tenants or users.

Isolation failures are catastrophic — a single cross-tenant data leak can expose sensitive business data, financial information, and customer PII. Therefore, isolation testing must be **continuous, systematic, and comprehensive**.

---

## 1. The Three Layers of Isolation

```
LAYER 1: Query Filtering      → WHERE tenant_id = ?
LAYER 2: Permission Guards    → IsUserInTenant()
LAYER 3: Soft Delete Scoping  → WHERE deleted_at IS NULL
```

All three layers must be tested independently and in combination.

---

## 2. Layer 1: Query Filtering Tests

### 2.1 Test: Direct Query Filter Enforcement

**Objective:** Verify that database queries always filter by `tenant_id`.

```typescript
describe('Query Filtering Layer', () => {
  let tenant1: Tenant;
  let tenant2: Tenant;
  let bookingService: BookingService;

  beforeEach(async () => {
    tenant1 = await createTenant('tenant-001');
    tenant2 = await createTenant('tenant-002');
    bookingService = new BookingService(mockRepository);
  });

  test('should NOT return tenant2 bookings when querying as tenant1', async () => {
    // Setup: Create bookings in both tenants
    const booking1 = await bookingService.create(
      { title: 'Booking A', tenantId: tenant1.id },
      tenant1.id
    );
    const booking2 = await bookingService.create(
      { title: 'Booking B', tenantId: tenant2.id },
      tenant2.id
    );

    // Execute: Query as tenant1
    const results = await bookingService.findAll(tenant1.id);

    // Assert: Only tenant1 booking visible
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(booking1.id);
    expect(results[0].title).toBe('Booking A');

    // Critical: Verify tenant2 booking is excluded
    const bookingIds = results.map((b) => b.id);
    expect(bookingIds).not.toContain(booking2.id);
  });

  test('should throw error if tenant_id filter is missing', async () => {
    // This test ensures the query cannot be executed without tenant_id
    const unsafeQuery = () => {
      // Attempting to call without tenant_id should fail
      return bookingService.findAll(undefined);
    };

    expect(unsafeQuery).toThrow('tenant_id is required');
  });

  test('should handle NULL tenant_id by returning empty results', async () => {
    const booking = await bookingService.create(
      { title: 'Test Booking', tenantId: tenant1.id },
      tenant1.id
    );

    // Query with NULL tenant_id should return nothing
    const results = await bookingService.findByTenantId(null);

    expect(results).toEqual([]);
  });

  test('should use composite index (tenant_id, field) for performance', async () => {
    // This test validates that queries use efficient indexes
    const spy = jest.spyOn(bookingService['repository'], 'query');

    await bookingService.findActive(tenant1.id);

    // Verify query uses composite index
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.stringContaining('tenant_id'),
      })
    );
  });
});
```

### 2.2 Test: Soft Delete Isolation

**Objective:** Verify that soft-deleted data is excluded from normal queries.

```typescript
describe('Soft Delete Isolation', () => {
  test('should exclude soft-deleted bookings from normal queries', async () => {
    const tenant = await createTenant('tenant-001');
    const activeBooking = await bookingService.create(
      { title: 'Active' },
      tenant.id
    );
    const deletedBooking = await bookingService.create(
      { title: 'Deleted' },
      tenant.id
    );

    // Soft delete the booking
    await bookingService.delete(deletedBooking.id, tenant.id);

    // Query should exclude soft-deleted
    const results = await bookingService.findAll(tenant.id);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(activeBooking.id);
  });

  test('should allow queries including soft-deleted for admins only', async () => {
    const tenant = await createTenant('tenant-001');
    const adminUser = await createUser(tenant.id, 'admin');
    const booking = await bookingService.create({ title: 'Test' }, tenant.id);

    await bookingService.delete(booking.id, tenant.id);

    // Admin can query with soft-deleted
    const results = await bookingService.findAllWithDeleted(
      tenant.id,
      adminUser.id
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test('should handle cascading soft deletes per tenant', async () => {
    const tenant = await createTenant('tenant-001');
    const booking = await bookingService.create({ title: 'Test' }, tenant.id);
    const lineItem = await bookingService.createLineItem(
      booking.id,
      { amount: 100 },
      tenant.id
    );

    // Soft delete parent
    await bookingService.delete(booking.id, tenant.id);

    // Child should also be soft-deleted, but only for this tenant
    const orphanedItems = await bookingService.findLineItems(
      booking.id,
      tenant.id
    );

    expect(orphanedItems).toHaveLength(0);
  });
});
```

---

## 3. Layer 2: Permission Guard Tests

### 3.1 Test: Cross-Tenant Access Rejection

**Objective:** Verify that users cannot access data from tenants they don't belong to.

```typescript
describe('Permission Guard: Cross-Tenant Rejection', () => {
  let tenant1: Tenant;
  let tenant2: Tenant;
  let user1: User;
  let user2: User;

  beforeEach(async () => {
    tenant1 = await createTenant('tenant-001');
    tenant2 = await createTenant('tenant-002');
    user1 = await createUser(tenant1.id, 'admin');
    user2 = await createUser(tenant2.id, 'admin');
  });

  test('user1 cannot read tenant2 data even with valid ID', async () => {
    // Setup: Create booking in tenant2
    const booking = await bookingService.create(
      { title: 'Secret Booking' },
      tenant2.id
    );

    // Attempt: user1 from tenant1 tries to access booking from tenant2
    const attempt = () =>
      bookingService.findById(booking.id, user1.id, tenant1.id);

    expect(attempt).rejects.toThrow('Unauthorized: Tenant mismatch');
  });

  test('user1 cannot update tenant2 data', async () => {
    const booking = await bookingService.create(
      { title: 'Secret Booking' },
      tenant2.id
    );

    const attempt = () =>
      bookingService.update(
        booking.id,
        { title: 'Hacked' },
        user1.id,
        tenant1.id
      );

    expect(attempt).rejects.toThrow('Unauthorized');
  });

  test('user1 cannot delete tenant2 data', async () => {
    const booking = await bookingService.create(
      { title: 'Secret Booking' },
      tenant2.id
    );

    const attempt = () =>
      bookingService.delete(booking.id, user1.id, tenant1.id);

    expect(attempt).rejects.toThrow('Unauthorized');
  });

  test('permission guard validates tenant context in JWT', async () => {
    // Simulate JWT with tenant_id claim
    const jwt = {
      userId: user1.id,
      tenantId: tenant1.id,
      roles: ['admin'],
    };

    // Attempt to call service with mismatched tenant
    const booking = await bookingService.create({ title: 'Test' }, tenant2.id);

    const attempt = () =>
      bookingService.findById(booking.id, jwt.userId, tenant2.id);

    expect(attempt).rejects.toThrow();
  });
});
```

### 3.2 Test: Role-Based Permission Boundaries

**Objective:** Verify that RBAC enforcement is tenant-scoped.

```typescript
describe('Permission Guard: Role-Based Boundaries', () => {
  let tenant: Tenant;
  let admin: User;
  let staff: User;
  let customer: User;

  beforeEach(async () => {
    tenant = await createTenant('tenant-001');
    admin = await createUser(tenant.id, 'admin');
    staff = await createUser(tenant.id, 'staff');
    customer = await createUser(tenant.id, 'customer');
  });

  test('customer cannot create booking for another customer', async () => {
    const targetCustomer = await createUser(tenant.id, 'customer');

    const attempt = () =>
      bookingService.createFor(
        targetCustomer.id,
        { title: 'Booking' },
        customer.id,
        tenant.id
      );

    expect(attempt).rejects.toThrow('Insufficient permissions');
  });

  test('staff can create booking but admin can only in their tenant', async () => {
    // Staff in tenant can create
    const booking1 = await bookingService.create(
      { title: 'By Staff' },
      staff.id,
      tenant.id
    );
    expect(booking1).toBeDefined();

    // Admin in tenant can create
    const booking2 = await bookingService.create(
      { title: 'By Admin' },
      admin.id,
      tenant.id
    );
    expect(booking2).toBeDefined();

    // But admin from different tenant cannot
    const admin2 = await createUser(await createTenant('tenant-002'), 'admin');

    const attempt = () =>
      bookingService.create({ title: 'Hacked' }, admin2.id, tenant.id);

    expect(attempt).rejects.toThrow();
  });

  test('role permissions are tenant-specific', async () => {
    // Create same user with different roles in different tenants
    const tenant2 = await createTenant('tenant-002');
    const userAsAdminInT1 = admin;
    const userAsStaffInT2 = await createUser(tenant2.id, 'staff');

    // Admin in tenant1 can perform admin actions
    const canAdminT1 = await permissionService.can(
      userAsAdminInT1.id,
      'bookings:delete',
      tenant.id
    );
    expect(canAdminT1).toBe(true);

    // Staff in tenant2 cannot perform admin actions
    const canAdminT2 = await permissionService.can(
      userAsStaffInT2.id,
      'bookings:delete',
      tenant2.id
    );
    expect(canAdminT2).toBe(false);
  });
});
```

---

## 4. Layer 3: Soft Delete Scoping

### 4.1 Test: Deleted Data Remains Isolated

**Objective:** Verify that soft-deleted data doesn't leak across tenants.

```typescript
describe('Soft Delete Scoping', () => {
  test('soft-deleted data stays within tenant boundary', async () => {
    const tenant1 = await createTenant('tenant-001');
    const tenant2 = await createTenant('tenant-002');

    const booking1 = await bookingService.create(
      { title: 'T1 Booking' },
      tenant1.id
    );
    const booking2 = await bookingService.create(
      { title: 'T2 Booking' },
      tenant2.id
    );

    // Soft delete both
    await bookingService.delete(booking1.id, tenant1.id);
    await bookingService.delete(booking2.id, tenant2.id);

    // Query tenant1 including soft-deleted
    const t1Deleted = await bookingService.findAllWithDeleted(tenant1.id);

    // Should not include tenant2's deleted booking
    const ids = t1Deleted.map((b) => b.id);
    expect(ids).toContain(booking1.id);
    expect(ids).not.toContain(booking2.id);
  });

  test('soft delete respects composite index (tenant_id, deleted_at)', async () => {
    const tenant = await createTenant('tenant-001');
    const booking1 = await bookingService.create(
      { title: 'Active' },
      tenant.id
    );
    const booking2 = await bookingService.create(
      { title: 'To Delete' },
      tenant.id
    );

    const spy = jest.spyOn(bookingService['repository'], 'query');

    await bookingService.findActive(tenant.id);

    // Query should use composite index
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.stringContaining('(tenant_id, deleted_at)'),
      })
    );
  });
});
```

---

## 5. Integration Layer: Multi-Step Isolation Tests

### 5.1 Test: Complex Permission + Query Flow

**Objective:** Verify isolation across multiple operations.

```typescript
describe('Integration: Multi-Step Isolation', () => {
  test('user cannot leak data through search + filter operations', async () => {
    const t1 = await createTenant('tenant-001');
    const t2 = await createTenant('tenant-002');
    const user1 = await createUser(t1.id, 'admin');

    // Create test data
    const bookings = [];
    for (let i = 0; i < 10; i++) {
      bookings.push(await bookingService.create({ title: `T1-${i}` }, t1.id));
    }
    for (let i = 0; i < 10; i++) {
      bookings.push(await bookingService.create({ title: `T2-${i}` }, t2.id));
    }

    // User1 performs search
    const results = await bookingService.search('T', user1.id, t1.id);

    // Should return only user1's bookings
    expect(results.length).toBe(10);
    results.forEach((r) => {
      expect(r.title).toMatch(/^T1-/);
    });
  });

  test('pagination does not leak between tenants', async () => {
    const t1 = await createTenant('tenant-001');
    const t2 = await createTenant('tenant-002');

    // Create 25 bookings in each tenant
    for (let i = 0; i < 25; i++) {
      await bookingService.create({ title: `T1-${i}` }, t1.id);
      await bookingService.create({ title: `T2-${i}` }, t2.id);
    }

    // Paginate through tenant1 (page size 10)
    const page1 = await bookingService.findPaginated(t1.id, {
      page: 1,
      pageSize: 10,
    });
    const page2 = await bookingService.findPaginated(t1.id, {
      page: 2,
      pageSize: 10,
    });

    // All results should be from tenant1
    const allIds = [...page1.data, ...page2.data].map((b) => b.id);

    // Verify no tenant2 booking appears
    const tenant2Booking = bookings.find((b) => b.title.startsWith('T2-'));
    expect(allIds).not.toContain(tenant2Booking?.id);
  });
});
```

---

## 6. Attack Scenarios & Defensive Tests

### 6.1 Test: JWT Token Tampering

```typescript
describe('Attack Scenario: JWT Token Tampering', () => {
  test('should reject forged tenant_id in JWT', async () => {
    const legitimateUser = await createUser(
      await createTenant('tenant-001'),
      'admin'
    );

    // Attacker forges JWT with different tenant_id
    const forgedJwt = {
      userId: legitimateUser.id,
      tenantId: 'tenant-002-hacked',
      roles: ['admin'],
    };

    // Attempt with forged JWT
    const booking = await bookingService.create(
      { title: 'Legitimate' },
      'tenant-001'
    );

    const attempt = () =>
      bookingService.findById(booking.id, forgedJwt.userId, forgedJwt.tenantId);

    expect(attempt).rejects.toThrow();
  });

  test('should reject JWT with elevated roles outside tenant', async () => {
    const user = await createUser(await createTenant('tenant-001'), 'staff');

    const forgedJwt = {
      userId: user.id,
      tenantId: 'tenant-001',
      roles: ['admin'], // Escalated to admin
    };

    // Admin action should still require legitimate admin role
    const booking = await bookingService.create(
      { title: 'Test' },
      'tenant-001'
    );

    // Forged JWT with admin claim but user is staff
    const attempt = () =>
      bookingService.delete(booking.id, user.id, 'tenant-001');

    // Should verify against database role, not JWT claim
    expect(attempt).rejects.toThrow();
  });
});
```

### 6.2 Test: SQL Injection / NoSQL Injection Attempts

```typescript
describe('Attack Scenario: Injection Attempts', () => {
  test('should safely handle SQL injection in search', async () => {
    const tenant = await createTenant('tenant-001');

    const maliciousQuery = "'; DELETE FROM bookings; --";

    const results = await bookingService.search(maliciousQuery, tenant.id);

    // Should treat as literal string, not execute
    expect(results).toEqual([]);

    // Verify data intact
    const bookings = await bookingService.findAll(tenant.id);
    expect(bookings.length).toBeGreaterThan(0);
  });

  test('should handle NoSQL injection attempts', async () => {
    const tenant = await createTenant('tenant-001');

    const maliciousFilter = {
      $ne: null, // MongoDB injection attempt
    };

    const results = await bookingService.search(maliciousFilter, tenant.id);

    expect(results).toEqual([]);
  });
});
```

---

## 7. Batch Operations & Aggregations

### 7.1 Test: Aggregations Stay Per-Tenant

```typescript
describe('Batch Operations: Aggregation Isolation', () => {
  test('analytics aggregations should not leak between tenants', async () => {
    const t1 = await createTenant('tenant-001');
    const t2 = await createTenant('tenant-002');

    // Create bookings in both tenants
    for (let i = 0; i < 5; i++) {
      await bookingService.create({ price: 100 }, t1.id);
      await bookingService.create({ price: 200 }, t2.id);
    }

    // Get aggregate for tenant1
    const t1Stats = await analyticsService.getBookingStats(t1.id);

    expect(t1Stats.count).toBe(5);
    expect(t1Stats.averagePrice).toBe(100);
    expect(t1Stats.totalRevenue).toBe(500);
  });

  test('batch delete should not cross tenant boundaries', async () => {
    const t1 = await createTenant('tenant-001');
    const t2 = await createTenant('tenant-002');

    const bookings = [];
    for (let i = 0; i < 3; i++) {
      bookings.push(
        await bookingService.create({ status: 'cancelled' }, t1.id)
      );
      bookings.push(
        await bookingService.create({ status: 'cancelled' }, t2.id)
      );
    }

    // Batch delete cancelled bookings for tenant1
    const deletedCount = await bookingService.deleteCancelled(t1.id);

    expect(deletedCount).toBe(3);

    // Verify tenant2 bookings remain
    const t2Remaining = await bookingService.findAll(t2.id);
    expect(t2Remaining).toHaveLength(3);
  });
});
```

---

## 8. Continuous Monitoring Tests

### 8.1 Test: Periodic Isolation Audits

```typescript
describe('Continuous Monitoring: Isolation Audits', () => {
  test('should audit all queries include tenant_id filter', async () => {
    // This test runs periodically to ensure no regression
    const queries = await codeAnalyzer.findAllDatabaseQueries();

    const unscoped = queries.filter((q) => !q.includesFilter('tenant_id'));

    expect(unscoped).toHaveLength(0);
    // If any found: Generate report and block deployment
  });

  test('should verify all repositories require tenant parameter', async () => {
    const repositories = await codeAnalyzer.findAllRepositories();

    repositories.forEach((repo) => {
      const methods = repo.getMethods();
      methods.forEach((method) => {
        if (method.name !== 'constructor') {
          const params = method.getParameters();
          expect(params).toContainEqual(
            expect.objectContaining({
              name: 'tenantId',
            })
          );
        }
      });
    });
  });

  test('should detect any new cross-tenant operations', async () => {
    // Scan for operations that accept data from multiple tenants
    const violations = await codeAnalyzer.findCrossTenantOps();

    violations.forEach((v) => {
      console.warn(`⚠️  Cross-tenant operation: ${v.file}:${v.line}`);
    });

    expect(violations).toHaveLength(0);
  });
});
```

---

## 9. Quality Gate: Pre-Deployment Isolation Verification

Before any deployment, run this comprehensive isolation verification:

```bash
#!/bin/bash

echo "🔒 Running Isolation Verification Suite..."

# 1. Unit tests
npm test -- --testPathPattern="isolation" --coverage

# 2. Cross-tenant scenario tests
npm test -- --testNamePattern="cross-tenant|tenant isolation|leak"

# 3. Permission boundary tests
npm test -- --testNamePattern="permission|unauthorized|reject"

# 4. Code audit: verify tenant_id filters
npm run audit:isolation

# 5. Performance: ensure indexes are used
npm run test:performance -- --testNamePattern="index|composite"

# Fail if any checks fail
if [ $? -ne 0 ]; then
  echo "❌ Isolation verification FAILED"
  exit 1
fi

echo "✅ Isolation verification PASSED"
```

---

## Next Steps

- **[TESTING_STRATEGY.md](./TESTING_STRATEGY.md)** — Return to testing strategy overview
- **[DATA_SEEDING.md](./DATA_SEEDING.md)** — Test data setup and fixtures
- **[Code Examples](./code-examples/testing/)** — Runnable isolation tests
