# Testing Strategy for Multi-Tenant Systems

## Overview

Testing multi-tenant systems requires a comprehensive strategy that ensures data isolation, permission enforcement, and system reliability across independent tenant environments. This document outlines the testing pyramid, isolation guarantees, mocking strategies, and coverage targets for production-grade multi-tenant SaaS platforms.

---

## 1. Test Pyramid Architecture

The test pyramid defines the distribution of test types, with emphasis on fast, isolated unit tests and selective integration/E2E coverage.

```
           ╱╲
          ╱  ╲        E2E Tests (5-10%)
         ╱────╲       - Full user journeys
        ╱      ╲      - Cross-tenant scenarios
       ╱  E2E   ╲     - External integrations
      ╱          ╲
     ╱────────────╲
    ╱              ╲   Integration Tests (20-30%)
   ╱ Integration    ╲  - API endpoints
  ╱                  ╲ - Service orchestration
 ╱──────────────────╲ - Database queries
╱                    ╲ - Permission enforcement
╱     Unit Tests      ╲ (60-70%)
╱    (Fast, Isolated)  ╲ - Business logic
──────────────────────── - Data transformations
                        - Utility functions
                        - Validators
```

### Test Distribution Targets

| Test Type   | % of Suite | Execution Time | Frequency    | Scope                  |
| ----------- | ---------- | -------------- | ------------ | ---------------------- |
| Unit        | 60-70%     | <100ms each    | Every commit | Single function/method |
| Integration | 20-30%     | 100ms-1s each  | Every PR     | Service layer, DBs     |
| E2E         | 5-10%      | >1s each       | Pre-deploy   | Full workflows         |
| Performance | <5%        | Variable       | Weekly       | Load patterns          |
| Security    | Embedded   | Variable       | Every PR     | Permission, injection  |

---

## 2. Multi-Tenant Testing Fundamentals

### 2.1 Core Testing Principle: Tenant Isolation

**Every test must operate in complete isolation.** This means:

- Each test has its own tenant context
- No shared state between tests
- No test data carries over between runs
- Tenant IDs are explicit, never implicit or assumed

### 2.2 Test Categories by Concern

#### A. Tenant Data Isolation Tests

Verify that data belonging to one tenant is never visible to another tenant.

**Test Scenarios:**

- Query filtering by `tenant_id` is applied
- Missing `tenant_id` filter throws or returns empty
- Soft-deleted data is excluded (even with correct tenant_id)
- Composite indexes on `(tenant_id, ...)` improve performance

#### B. Permission & RBAC Tests

Verify that role-based access controls are enforced per tenant.

**Test Scenarios:**

- User roles are tenant-scoped
- Permission checks validate tenant context before granting access
- Cross-tenant role claims are rejected
- Resource-level permissions are tenant-aware

#### C. Multi-Tenant Workflow Tests

Verify that operations span tenants correctly without leakage.

**Test Scenarios:**

- User can switch contexts between their assigned tenants
- Each tenant sees only its own data
- Batch operations (e.g., analytics) aggregate by tenant
- Background jobs process data per tenant

#### D. Regression Tests

Verify no new code introduces tenant leakage.

**Test Scenarios:**

- Query audits ensure `tenant_id` filtering on new repositories
- Permission guards are tested on all new endpoints
- Schema changes maintain tenant isolation constraints

---

## 3. Mocking Strategies for Multi-Tenant Testing

### 3.1 Tenant Context Mock

Mock the authenticated user's tenant context (tenant_id, roles, permissions).

```typescript
// Mock tenant context
const mockTenantContext = {
  tenantId: 'tenant-001',
  userId: 'user-001',
  roles: ['admin'],
  permissions: ['bookings:read', 'bookings:write'],
  scope: 'salon:booking:management',
};

// Inject into request context
test('should fetch bookings for authenticated tenant', async () => {
  const ctx = mockTenantContext;
  const result = await bookingService.find({ tenantId: ctx.tenantId });
  expect(result).toHaveLength(3);
});
```

### 3.2 User Mock with Role Hierarchy

Mock users at different permission levels within a tenant.

```typescript
const mockAdminUser = {
  id: 'admin-001',
  tenantId: 'tenant-001',
  email: 'admin@salon.com',
  roles: ['admin'],
  permissions: ['*'],
};

const mockStaffUser = {
  id: 'staff-001',
  tenantId: 'tenant-001',
  email: 'staff@salon.com',
  roles: ['staff'],
  permissions: ['bookings:read', 'bookings:update'],
};

const mockCustomerUser = {
  id: 'customer-001',
  tenantId: 'tenant-001',
  email: 'customer@salon.com',
  roles: ['customer'],
  permissions: ['bookings:read', 'bookings:create'],
};
```

### 3.3 Repository Mock with Tenant Scoping

Mock data repositories to enforce tenant isolation.

```typescript
class MockBookingRepository {
  private bookings: Booking[] = [];

  async findByTenantId(tenantId: string): Promise<Booking[]> {
    // CRITICAL: Always filter by tenant_id
    return this.bookings.filter((b) => b.tenantId === tenantId);
  }

  async findById(id: string, tenantId: string): Promise<Booking | null> {
    // CRITICAL: Require tenant_id parameter
    const booking = this.bookings.find((b) => b.id === id);
    if (booking && booking.tenantId !== tenantId) {
      return null; // Tenant isolation enforced
    }
    return booking || null;
  }

  async create(data: BookingCreateDto, tenantId: string): Promise<Booking> {
    // CRITICAL: Always assign tenant_id
    const booking = { ...data, id: generateId(), tenantId };
    this.bookings.push(booking);
    return booking;
  }
}
```

### 3.4 Permission Guard Mock

Mock RBAC guards to validate permission checks in tests.

```typescript
class MockPermissionGuard {
  canAccess(user: MockUser, resource: string, action: string): boolean {
    // Validate user has permission for action
    const hasPermission = user.permissions.includes(`${resource}:${action}`);
    return hasPermission;
  }

  canViewTenant(user: MockUser, tenantId: string): boolean {
    // Validate user belongs to tenant
    return user.tenantId === tenantId;
  }

  canBatch(users: MockUser[], tenantId: string): boolean {
    // Validate all users belong to same tenant
    return users.every((u) => u.tenantId === tenantId);
  }
}
```

### 3.5 Database Transaction Mock

Mock database transactions to ensure isolation per test.

```typescript
class MockTransaction {
  private isActive = false;
  private changes: any[] = [];

  async begin(): Promise<void> {
    this.isActive = true;
    this.changes = [];
  }

  async commit(): Promise<void> {
    if (!this.isActive) {
      throw new Error('No active transaction');
    }
    // Apply changes
    this.isActive = false;
  }

  async rollback(): Promise<void> {
    // Discard changes
    this.changes = [];
    this.isActive = false;
  }
}
```

---

## 4. Test Isolation Guarantees

### 4.1 Before Each Test: Setup

```typescript
beforeEach(async () => {
  // 1. Clear all test data
  await db.clear();

  // 2. Create isolated tenant context
  testTenant = {
    id: `tenant-${Date.now()}`,
    name: 'Test Tenant',
    plan: 'starter',
  };
  await db.tenants.create(testTenant);

  // 3. Create test users for this tenant only
  testAdmin = {
    id: `user-admin-${Date.now()}`,
    tenantId: testTenant.id,
    role: 'admin',
  };
  await db.users.create(testAdmin);

  // 4. Inject tenant context
  mockContext = {
    tenantId: testTenant.id,
    userId: testAdmin.id,
    roles: ['admin'],
  };
});
```

### 4.2 After Each Test: Cleanup

```typescript
afterEach(async () => {
  // 1. Clear test data
  await db.tenants.delete(testTenant.id);
  await db.users.delete(testAdmin.id);

  // 2. Verify no leaked data
  const allTenants = await db.tenants.findAll();
  expect(allTenants).not.toContain(testTenant);

  // 3. Reset mocks
  jest.clearAllMocks();
});
```

### 4.3 Parallel Test Execution Safety

```typescript
// Use unique identifiers to prevent collisions
describe('Booking Service', () => {
  const testId = `test-${Date.now()}-${Math.random()}`;

  beforeEach(async () => {
    tenant1 = { id: `${testId}-tenant-1` };
    tenant2 = { id: `${testId}-tenant-2` };
  });

  // Tests run in parallel without interference
  test('tenant 1 cannot access tenant 2 data', async () => {
    // Isolated to this test
  });

  test('tenant 2 cannot access tenant 1 data', async () => {
    // Isolated to this test
  });
});
```

---

## 5. Coverage Targets

### 5.1 Code Coverage Thresholds

| Category       | Target | Rationale                           |
| -------------- | ------ | ----------------------------------- |
| **Statements** | >80%   | Core business logic must be covered |
| **Branches**   | >75%   | Permission paths, error handling    |
| **Functions**  | >80%   | All public APIs tested              |
| **Lines**      | >80%   | Executable code coverage            |

**Critical High-Coverage Areas (>90%):**

- Permission guards and RBAC logic
- Tenant isolation filters
- Data validation and transformation
- Error handling and edge cases

**Lower-Coverage Areas (>60%):**

- Logging and monitoring
- Third-party integrations
- UI presentation logic

### 5.2 Coverage Enforcement

```bash
# Run coverage check
npm test -- --coverage

# Enforce minimum thresholds
npm test -- --coverage --coverageThreshold='{"global":{"statements":80,"branches":75,"functions":80,"lines":80}}'

# Generate coverage report
npm test -- --coverage --coverageReporters=html

# View coverage
open coverage/index.html
```

### 5.3 What to Avoid Over-Testing

**Don't over-test:**

- Third-party library behavior (assume it works)
- External API responses (mock them)
- Framework features (trust the framework)
- Trivial getter/setter methods

**Focus on:**

- Business logic correctness
- Tenant isolation enforcement
- Permission boundary validation
- Error scenarios and edge cases

---

## 6. Testing Phases

### Phase 1: Unit Testing (60-70% of suite)

Focus: Individual functions, pure business logic

**What to test:**

- Validators (email format, phone number)
- Formatters (date/currency conversion)
- Calculators (price, commission, discount)
- Transformers (DTO to Entity mapping)

### Phase 2: Integration Testing (20-30% of suite)

Focus: Service interactions, database operations, permission gates

**What to test:**

- API endpoints with tenant context
- Database queries with filters
- Permission guards on actions
- Transaction handling

### Phase 3: E2E Testing (5-10% of suite)

Focus: Full user workflows, multi-tenant scenarios

**What to test:**

- User login → booking creation → payment
- Tenant admin creates staff → staff logs in
- Cross-tenant data isolation in UI
- System behavior under load

---

## 7. Test Execution Pipeline

### Local Development

```bash
# Run all tests with coverage
npm test -- --coverage

# Run tests in watch mode
npm test -- --watch

# Run specific test file
npm test -- booking.service.test.ts

# Run tests matching pattern
npm test -- --testNamePattern="tenant isolation"
```

### Pre-Commit Checks

```bash
# ESLint, Type checking, Unit tests
npm run pre-commit
```

### Pre-PR Validation

```bash
# All tests + coverage + performance
npm run test:full
npm run performance:test
npm run security:test
```

### Pre-Deploy Validation

```bash
# All tests + E2E + load test
npm run test:complete
npm run e2e:all
npm run load-test
```

---

## 8. Multi-Tenant Test Scenarios

### Scenario 1: Cross-Tenant Data Leakage Prevention

```
Tenant A creates booking → Tenant B queries database → Booking NOT visible to Tenant B
```

### Scenario 2: Permission Boundary Enforcement

```
Tenant A staff member → Cannot access Tenant B data → Even with valid JWT
```

### Scenario 3: Role-Based Access Control

```
Customer role in Tenant A → Can only perform customer actions
Admin role in Tenant A → Can perform all actions within Tenant A only
```

### Scenario 4: Soft Delete Isolation

```
Tenant A deletes booking (soft delete) → Booking still in DB with deleted_at
Tenant A queries bookings → Deleted booking NOT returned
Tenant A admin queries all → Deleted booking shown in audit
```

### Scenario 5: Batch Operations Per Tenant

```
Analytics aggregates bookings by tenant
Each tenant sees only their own aggregate data
No tenant sees aggregates from other tenants
```

---

## 9. Recommended Tools & Frameworks

| Tool                    | Purpose      | Multi-Tenant Use                          |
| ----------------------- | ------------ | ----------------------------------------- |
| **Jest**                | Test runner  | Parallel test execution, snapshot testing |
| **Supertest**           | HTTP testing | API endpoint isolation per tenant         |
| **Mock Service Worker** | API mocking  | Mock tenant-scoped responses              |
| **Testcontainers**      | DB testing   | Real DB with transaction isolation        |
| **K6/Artillery**        | Load testing | Multi-tenant load scenarios               |
| **Cypress/Playwright**  | E2E testing  | User workflows across tenants             |

---

## 10. Common Testing Pitfalls & Solutions

| Pitfall                              | Impact          | Solution                           |
| ------------------------------------ | --------------- | ---------------------------------- |
| Missing `tenant_id` filter           | Data leakage    | Code review checklist, lint rule   |
| Shared test data                     | Flaky tests     | Use unique IDs, cleanup after each |
| Mocking permission guard incorrectly | False positives | Test permission paths explicitly   |
| No transaction rollback              | Test pollution  | Use beforeEach/afterEach           |
| Testing framework code               | Slow suite      | Focus on business logic            |
| Hard-coded test IDs                  | Collision in CI | Use timestamps + random IDs        |

---

## 11. Quality Gates Before Deployment

```
✓ All tests passing (unit, integration, E2E)
✓ Code coverage > 80% (statements, branches, functions, lines)
✓ No console errors or warnings
✓ Tenant isolation validated with cross-tenant scenarios
✓ Permission boundaries tested for all roles
✓ Performance regression < 10% from baseline
✓ Security scan passed (no injection, CORS issues)
✓ Load test passed (100 concurrent users per tenant)
```

---

## Next Steps

- **[ISOLATION_TESTING.md](./ISOLATION_TESTING.md)** — Comprehensive tenant isolation testing patterns
- **[DATA_SEEDING.md](./DATA_SEEDING.md)** — Test fixture and data setup strategies
- **[PERFORMANCE_TESTING.md](./PERFORMANCE_TESTING.md)** — Load testing and performance validation
- **[Code Examples](./code-examples/testing/)** — Runnable test implementations
