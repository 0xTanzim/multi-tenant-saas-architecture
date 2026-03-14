# Testing Code Examples

Runnable test examples demonstrating multi-tenant testing patterns for DoneByMe and similar SaaS platforms.

## Files

### 1. e2e-multi-tenant.test.ts

End-to-end tests demonstrating complete booking workflows with multiple independent tenants.

**Key Scenarios:**

- Tenant can create and retrieve their own bookings
- Tenant1 cannot see Tenant2's bookings
- Cross-tenant booking retrieval is blocked
- Multiple tenants operate simultaneously without interference
- Booking operations are tenant-scoped
- Concurrent operations maintain isolation
- Query performance is consistent across tenants

**Run:**

```bash
npm test -- e2e-multi-tenant.test.ts
```

**Interview Value:** Shows understanding of full-stack E2E workflows, isolation guarantees, and concurrent safety.

---

### 2. isolation-validation.test.ts

Deep isolation validation tests proving tenant data never leaks across boundaries.

**Test Layers:**

- **Query Filtering Layer** (Layer 1)

  - Query filter enforcement
  - Tenant isolation in read operations
  - Point query with tenant validation
  - Large dataset isolation (10k+ records)

- **Soft Delete Scoping** (Layer 2)

  - Soft-deleted data exclusion
  - Tenant boundary respect for deleted data
  - Prevention of unintentional cross-tenant exposure

- **Permission Guard Integration** (Layer 3)

  - Cross-tenant attack prevention
  - Batch operation isolation
  - Concurrent access safety

- **Isolation Audit**
  - Code verification that all methods require tenant context

**Run:**

```bash
npm test -- isolation-validation.test.ts
```

**Interview Value:** Demonstrates depth of isolation thinking, attack scenario analysis, and defensive testing practices.

---

### 3. permission-guard.test.ts

RBAC enforcement tests validating role-based access control at tenant and resource levels.

**Test Categories:**

- **Role-Based Access Control (RBAC)**

  - Admin permissions (full access)
  - Manager permissions (elevated but not admin)
  - Staff permissions (limited write access)
  - Customer permissions (read-only)

- **Cross-Tenant Rejection**

  - Users cannot access resources from other tenants
  - Tenant check happens before permission check
  - Admin from different tenant is still rejected

- **Resource-Level Checks**

  - Owner-based resource access
  - Role-based delete permissions
  - Ownership vs role precedence

- **Escalation Prevention**

  - JWT role claims cannot escalate permissions
  - Database must verify actual permissions
  - Cross-tenant escalation is prevented

- **Concurrent Safety**
  - Concurrent permission checks are independent
  - Permission state is immutable

**Run:**

```bash
npm test -- permission-guard.test.ts
```

**Interview Value:** Shows understanding of distributed permission models, JWT security risks, and defense-in-depth architecture.

---

## Test Execution

### All Tests

```bash
npm test -- code-examples/testing/
```

### With Coverage

```bash
npm test -- code-examples/testing/ --coverage
```

### Watch Mode

```bash
npm test -- code-examples/testing/ --watch
```

### Specific Test

```bash
npm test -- code-examples/testing/e2e-multi-tenant.test.ts --testNamePattern="cannot access"
```

---

## Key Testing Patterns Demonstrated

### 1. Test Isolation

```typescript
beforeEach(() => {
  // Fresh test data for each test
  repo = new MockBookingRepository();
});

afterEach(() => {
  // Complete cleanup
  repo.clear();
});
```

### 2. Deterministic Test IDs

```typescript
const testId = `test-${Date.now()}-${testName}`;
// Enables reproducible tests and parallel execution
```

### 3. Multi-Tenant Fixtures

```typescript
const tenant1 = createTenantId(1);
const tenant2 = createTenantId(2);
// Isolated test environments
```

### 4. Isolation Verification

```typescript
test('tenant1 cannot see tenant2 data', async () => {
  const results = await repo.findByTenantId(tenant1);
  expect(results).not.toContain(tenant2Data);
});
```

### 5. Permission Boundary Testing

```typescript
test('customer cannot delete bookings', async () => {
  const can = await guard.can(customer, 'bookings:delete');
  expect(can).toBe(false);
});
```

### 6. Attack Scenario Coverage

```typescript
test('cannot bypass isolation by guessing IDs', async () => {
  // Attacker tries known IDs as different tenant
  const result = await repo.findById(id, attackerTenant);
  expect(result).toBeNull(); // Should fail
});
```

---

## Integration with Real Project

### Adapt to DoneByMe

1. Replace mock classes with actual service classes
2. Use real database (or testcontainers)
3. Inject actual permission guards
4. Use real authentication tokens

### Example

```typescript
import { BookingService } from '@/api/bookings';
import { PermissionGuard } from '@/api/common/guards';

describe('Real Booking Service', () => {
  let service: BookingService;
  let guard: PermissionGuard;

  beforeEach(async () => {
    // Use actual implementations
    service = new BookingService(realRepository);
    guard = realPermissionGuard;
  });
});
```

---

## Performance Targets

| Test             | Target  | Actual     |
| ---------------- | ------- | ---------- |
| Unit test        | < 10ms  | ~1ms       |
| Integration test | < 100ms | ~5-50ms    |
| E2E test         | < 1s    | ~100-500ms |
| Isolation audit  | < 200ms | ~10ms      |

---

## Coverage Expectations

- **Statements:** 90%+ (critical business logic)
- **Branches:** 85%+ (permission paths, error cases)
- **Functions:** 90%+ (all public APIs)
- **Lines:** 90%+ (all executable code)

---

## Interview Talking Points

1. **Why isolation tests are critical:**

   - Multi-tenant data leakage is catastrophic
   - Single bug exposes all customer data
   - Requires three-layer testing approach

2. **How to prove isolation works:**

   - Query filtering layer (WHERE tenant_id)
   - Permission guards (user context)
   - Soft delete scoping (deleted_at)

3. **Attack scenarios to consider:**

   - JWT tampering (role elevation)
   - Cross-tenant ID guessing
   - SQL injection attempts
   - Concurrent race conditions

4. **Best practices demonstrated:**
   - Deterministic test IDs (reproducible)
   - Complete cleanup (test independence)
   - Mock repositories (fast, isolated)
   - Builder pattern (flexible fixtures)

---

## Next Steps

- **[TESTING_STRATEGY.md](../TESTING_STRATEGY.md)** — Full testing strategy documentation
- **[ISOLATION_TESTING.md](../ISOLATION_TESTING.md)** — Deep isolation patterns
- **[DATA_SEEDING.md](../DATA_SEEDING.md)** — Test data setup strategies
- **[PERFORMANCE_TESTING.md](../PERFORMANCE_TESTING.md)** — Load and performance tests

---

## Running in CI/CD

```yaml
# Example GitHub Actions
- name: Run isolation tests
  run: npm test -- isolation-validation.test.ts --coverage

- name: Run RBAC tests
  run: npm test -- permission-guard.test.ts --coverage

- name: Run E2E tests
  run: npm test -- e2e-multi-tenant.test.ts --coverage

- name: Check coverage thresholds
  run: npm run coverage:check -- --threshold=80
```

---

## Questions?

These examples demonstrate production-ready testing patterns for multi-tenant systems. Adapt them to your specific architecture and data models.
