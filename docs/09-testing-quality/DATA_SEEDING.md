# Test Data Seeding Strategy

## Overview

Effective test data seeding is critical for reproducible, reliable tests. This document outlines strategies for creating isolated test fixtures, managing relationships across multiple tenants, and ensuring tests remain deterministic and fast.

---

## 1. Seeding Philosophy

### Principles

1. **Isolation**: Each test has its own data; no shared fixtures
2. **Reproducibility**: Same seed produces same data every time
3. **Determinism**: No random IDs or timestamps (use controlled values)
4. **Cleanup**: All data removed after test completion
5. **Minimal**: Only create data needed for the specific test
6. **Performance**: Seeding should be fast (<100ms per test)

### Anti-Patterns to Avoid

```typescript
// ❌ Anti-pattern 1: Global shared fixtures
const globalTenant = new Tenant(); // Shared across tests
beforeEach(() => {
  // Tests modify global data → flaky
});

// ❌ Anti-pattern 2: Non-deterministic IDs
const id = Math.random(); // Each run different
const id = uuid(); // Cannot reproduce

// ❌ Anti-pattern 3: No cleanup
afterEach(() => {
  // No data deletion → accumulation
});

// ❌ Anti-pattern 4: Over-seeding
beforeEach(async () => {
  // Create 1000 records for single test → slow
});
```

---

## 2. Multi-Tenant Fixture Strategy

### 2.1 Deterministic Test IDs

```typescript
// Use test-specific identifiers
class TestDataFactory {
  private testId: string;

  constructor(testName: string) {
    // Create deterministic ID from test name + timestamp
    this.testId = `test-${Date.now()}-${testName.replace(/\s+/g, '-')}`;
  }

  createTenantId(): string {
    return `tenant-${this.testId}`;
  }

  createUserId(index: number): string {
    return `user-${this.testId}-${index}`;
  }

  createBookingId(index: number): string {
    return `booking-${this.testId}-${index}`;
  }
}

// Usage in tests
describe('Booking Service', () => {
  let factory: TestDataFactory;

  beforeEach(() => {
    factory = new TestDataFactory('booking-service');
  });
});
```

### 2.2 Minimal Tenant Fixture

```typescript
interface TenantFixture {
  tenant: Tenant;
  admin: User;
  staff: User[];
  customers: User[];
  bookings: Booking[];
  services: Service[];
}

async function createMinimalTenantFixture(
  testName: string
): Promise<TenantFixture> {
  const factory = new TestDataFactory(testName);
  const tenantId = factory.createTenantId();

  // 1. Create tenant
  const tenant = await db.tenants.create({
    id: tenantId,
    name: `Test Salon - ${testName}`,
    plan: 'starter',
    status: 'active',
  });

  // 2. Create admin user (required for most operations)
  const admin = await db.users.create({
    id: factory.createUserId(0),
    tenantId,
    email: `admin-${tenantId}@test.com`,
    role: 'admin',
    status: 'active',
  });

  // 3. Create staff (empty by default, add as needed)
  const staff: User[] = [];

  // 4. Create customers (empty by default, add as needed)
  const customers: User[] = [];

  // 5. Create services (empty by default, add as needed)
  const services: Service[] = [];

  // 6. Create bookings (empty by default, add as needed)
  const bookings: Booking[] = [];

  return {
    tenant,
    admin,
    staff,
    customers,
    bookings,
    services,
  };
}
```

### 2.3 Builder Pattern for Flexible Fixtures

```typescript
class TenantFixtureBuilder {
  private fixture: TenantFixture;
  private factory: TestDataFactory;

  constructor(testName: string) {
    this.factory = new TestDataFactory(testName);
  }

  async build(): Promise<TenantFixture> {
    const tenantId = this.factory.createTenantId();

    this.fixture = {
      tenant: await db.tenants.create({
        id: tenantId,
        name: `Test Tenant`,
      }),
      admin: null,
      staff: [],
      customers: [],
      bookings: [],
      services: [],
    };

    return this.fixture;
  }

  async withAdmin(): Promise<this> {
    this.fixture.admin = await db.users.create({
      id: this.factory.createUserId(0),
      tenantId: this.fixture.tenant.id,
      role: 'admin',
    });
    return this;
  }

  async withStaff(count: number): Promise<this> {
    for (let i = 0; i < count; i++) {
      const staff = await db.users.create({
        id: this.factory.createUserId(100 + i),
        tenantId: this.fixture.tenant.id,
        role: 'staff',
      });
      this.fixture.staff.push(staff);
    }
    return this;
  }

  async withCustomers(count: number): Promise<this> {
    for (let i = 0; i < count; i++) {
      const customer = await db.users.create({
        id: this.factory.createUserId(200 + i),
        tenantId: this.fixture.tenant.id,
        role: 'customer',
      });
      this.fixture.customers.push(customer);
    }
    return this;
  }

  async withBookings(count: number): Promise<this> {
    for (let i = 0; i < count; i++) {
      const booking = await db.bookings.create({
        id: this.factory.createBookingId(i),
        tenantId: this.fixture.tenant.id,
        customerId:
          this.fixture.customers[i % this.fixture.customers.length]?.id,
        status: 'confirmed',
      });
      this.fixture.bookings.push(booking);
    }
    return this;
  }

  getFixture(): TenantFixture {
    return this.fixture;
  }
}

// Usage: Flexible, readable, minimal
describe('Booking Service', () => {
  test('should list bookings for customer', async () => {
    const fixture = await new TenantFixtureBuilder('booking-list')
      .build()
      .then((b) => b.withAdmin())
      .then((b) => b.withCustomers(3))
      .then((b) => b.withBookings(5))
      .then((b) => b.getFixture());

    // Only creates what's needed
  });
});
```

---

## 3. Cross-Tenant Test Fixtures

### 3.1 Multiple Independent Tenants

```typescript
interface MultiTenantFixture {
  tenants: {
    [key: string]: TenantFixture;
  };
}

async function createMultiTenantFixture(
  testName: string,
  tenantCount: number
): Promise<MultiTenantFixture> {
  const fixture: MultiTenantFixture = {
    tenants: {},
  };

  for (let i = 0; i < tenantCount; i++) {
    const tenantFixture = await createMinimalTenantFixture(
      `${testName}-tenant-${i}`
    );
    fixture.tenants[`tenant${i}`] = tenantFixture;
  }

  return fixture;
}

// Usage in cross-tenant tests
describe('Cross-Tenant Isolation', () => {
  test('tenant1 cannot access tenant2 data', async () => {
    const multi = await createMultiTenantFixture('cross-tenant-test', 2);

    const t1 = multi.tenants['tenant0'];
    const t2 = multi.tenants['tenant1'];

    // Create booking in tenant2
    const booking = await bookingService.create(
      { title: 'Secret' },
      t2.tenant.id
    );

    // Try to access from tenant1
    const attempt = () =>
      bookingService.findById(booking.id, t1.admin.id, t1.tenant.id);

    expect(attempt).rejects.toThrow();
  });
});
```

### 3.2 Pre-Defined Test Scenarios

```typescript
// Scenario 1: Single tenant with full hierarchy
async function createScenario_SingleTenantFull(testName: string) {
  return new TenantFixtureBuilder(testName)
    .build()
    .then((b) => b.withAdmin())
    .then((b) => b.withStaff(3))
    .then((b) => b.withCustomers(10))
    .then((b) => b.withBookings(20))
    .then((b) => b.getFixture());
}

// Scenario 2: Two tenants for isolation testing
async function createScenario_TwoTenants(testName: string) {
  return createMultiTenantFixture(testName, 2);
}

// Scenario 3: Tenant with specific user roles
async function createScenario_RoleHierarchy(testName: string) {
  const fixture = await new TenantFixtureBuilder(testName).build();

  // Create users with specific roles
  await db.users.create({
    id: `user-owner-${fixture.tenant.id}`,
    tenantId: fixture.tenant.id,
    role: 'owner',
  });

  await db.users.create({
    id: `user-manager-${fixture.tenant.id}`,
    tenantId: fixture.tenant.id,
    role: 'manager',
  });

  // ... more roles

  return fixture;
}
```

---

## 4. Relationship & Dependency Seeding

### 4.1 Creating Related Data

```typescript
async function seedBookingWithRelations(
  tenantId: string,
  factory: TestDataFactory
): Promise<{
  booking: Booking;
  customer: User;
  staff: User;
  service: Service;
  lineItems: LineItem[];
}> {
  // 1. Create customer
  const customer = await db.users.create({
    id: factory.createUserId(Math.random()),
    tenantId,
    role: 'customer',
  });

  // 2. Create staff
  const staff = await db.users.create({
    id: factory.createUserId(Math.random()),
    tenantId,
    role: 'staff',
  });

  // 3. Create service
  const service = await db.services.create({
    id: factory.createServiceId(0),
    tenantId,
    name: 'Haircut',
    price: 50,
  });

  // 4. Create booking
  const booking = await db.bookings.create({
    id: factory.createBookingId(0),
    tenantId,
    customerId: customer.id,
    staffId: staff.id,
    startTime: new Date(),
    endTime: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
  });

  // 5. Create line items
  const lineItems = [];
  for (let i = 0; i < 3; i++) {
    const item = await db.lineItems.create({
      id: factory.createLineItemId(i),
      tenantId,
      bookingId: booking.id,
      serviceId: service.id,
      quantity: 1,
      price: service.price,
    });
    lineItems.push(item);
  }

  return {
    booking,
    customer,
    staff,
    service,
    lineItems,
  };
}
```

### 4.2 Cascade Data Creation

```typescript
async function createBookingHierarchy(
  tenantId: string,
  count: number
): Promise<Booking[]> {
  const bookings: Booking[] = [];

  for (let i = 0; i < count; i++) {
    // Create service (or reuse)
    const service =
      i === 0
        ? await db.services.create({
            id: `service-${tenantId}-${i}`,
            tenantId,
            name: `Service ${i}`,
            price: 50 + i * 10,
          })
        : bookings[0]; // Reuse first for efficiency

    // Create customer
    const customer = await db.users.create({
      id: `customer-${tenantId}-${i}`,
      tenantId,
      role: 'customer',
    });

    // Create booking
    const booking = await db.bookings.create({
      id: `booking-${tenantId}-${i}`,
      tenantId,
      customerId: customer.id,
      serviceId: service.id,
      startTime: new Date(Date.now() + i * 24 * 60 * 60 * 1000), // Offset by days
    });

    bookings.push(booking);
  }

  return bookings;
}
```

---

## 5. Cleanup Strategies

### 5.1 Per-Test Cleanup

```typescript
afterEach(async () => {
  // Get test-specific data
  const testId = expect.getState().currentTestName;

  // Delete in reverse order of creation (respects foreign keys)
  await db.lineItems.deleteWhere({ id: { $regex: `${testId}` } });
  await db.bookings.deleteWhere({ id: { $regex: `${testId}` } });
  await db.services.deleteWhere({ id: { $regex: `${testId}` } });
  await db.users.deleteWhere({ id: { $regex: `${testId}` } });
  await db.tenants.deleteWhere({ id: { $regex: `${testId}` } });
});
```

### 5.2 Transaction-Based Cleanup

```typescript
// More efficient: run test in transaction, rollback after
describe('Booking Service with Transactions', () => {
  let transaction: Transaction;

  beforeEach(async () => {
    transaction = await db.startTransaction();
  });

  afterEach(async () => {
    await transaction.rollback(); // Auto-cleanup
  });

  test('should create booking', async () => {
    const booking = await bookingService.create(
      { title: 'Test' },
      'tenant-001',
      { transaction }
    );

    expect(booking).toBeDefined();
    // Auto-cleanup via rollback
  });
});
```

### 5.3 Cascade Cleanup with FK Constraints

```typescript
async function cleanupTenant(tenantId: string): Promise<void> {
  // Delete in dependency order (children before parents)

  // Level 1: Leaf nodes (no children)
  await db.lineItems.deleteWhere({ tenantId });
  await db.reviews.deleteWhere({ tenantId });
  await db.payments.deleteWhere({ tenantId });

  // Level 2: Intermediate nodes
  await db.bookings.deleteWhere({ tenantId });
  await db.services.deleteWhere({ tenantId });
  await db.timeOffPeriods.deleteWhere({ tenantId });

  // Level 3: Parent entities
  await db.users.deleteWhere({ tenantId });
  await db.roles.deleteWhere({ tenantId });

  // Level 4: Tenant itself
  await db.tenants.delete(tenantId);
}
```

---

## 6. Performance Optimization

### 6.1 Reuse Fixtures Where Appropriate

```typescript
describe('Booking List Tests', () => {
  let fixture: TenantFixture;

  // Setup once for all tests in this suite
  beforeAll(async () => {
    fixture = await createMinimalTenantFixture('booking-list-suite');
  });

  // But each test gets fresh data
  beforeEach(async () => {
    // Clear test-specific bookings
    await db.bookings.deleteWhere({
      tenantId: fixture.tenant.id,
    });
  });

  test('should list bookings', async () => {
    await createBookingHierarchy(fixture.tenant.id, 5);
    // ...
  });

  test('should filter bookings', async () => {
    await createBookingHierarchy(fixture.tenant.id, 10);
    // ...
  });

  afterAll(async () => {
    // Cleanup shared fixture
    await cleanupTenant(fixture.tenant.id);
  });
});
```

### 6.2 Batch Insertion

```typescript
async function createBulkBookings(
  tenantId: string,
  count: number
): Promise<Booking[]> {
  // Batch insert instead of creating one-by-one
  const bookings = Array.from({ length: count }, (_, i) => ({
    id: `booking-${tenantId}-${i}`,
    tenantId,
    customerId: `customer-${i}`,
    status: 'confirmed',
  }));

  // Single query instead of N queries
  return db.bookings.insertMany(bookings);
}
```

---

## 7. Seeding Utilities

### 7.1 Reusable Seed Functions

```typescript
// Place in shared test utilities
export class TestSeeder {
  static async createTenant(name?: string): Promise<Tenant> {
    return db.tenants.create({
      id: `test-tenant-${Date.now()}`,
      name: name || 'Test Tenant',
      plan: 'starter',
    });
  }

  static async createUser(
    tenantId: string,
    role: string = 'user'
  ): Promise<User> {
    return db.users.create({
      id: `test-user-${Date.now()}-${Math.random()}`,
      tenantId,
      role,
      email: `test-${Date.now()}@example.com`,
    });
  }

  static async createBooking(
    tenantId: string,
    customerId: string
  ): Promise<Booking> {
    return db.bookings.create({
      id: `test-booking-${Date.now()}`,
      tenantId,
      customerId,
      startTime: new Date(),
      status: 'confirmed',
    });
  }
}

// Usage
test('should create booking', async () => {
  const tenant = await TestSeeder.createTenant();
  const user = await TestSeeder.createUser(tenant.id);
  const booking = await TestSeeder.createBooking(tenant.id, user.id);
});
```

### 7.2 Seed Configuration

```typescript
interface SeedConfig {
  tenantCount: number;
  usersPerTenant: number;
  bookingsPerUser: number;
  includePayments: boolean;
  includeReviews: boolean;
}

async function seedTestEnvironment(
  config: SeedConfig
): Promise<{ tenants: Tenant[]; users: User[]; bookings: Booking[] }> {
  const results = {
    tenants: [],
    users: [],
    bookings: [],
  };

  for (let t = 0; t < config.tenantCount; t++) {
    const tenant = await TestSeeder.createTenant(`Tenant ${t}`);
    results.tenants.push(tenant);

    for (let u = 0; u < config.usersPerTenant; u++) {
      const user = await TestSeeder.createUser(tenant.id);
      results.users.push(user);

      for (let b = 0; b < config.bookingsPerUser; b++) {
        const booking = await TestSeeder.createBooking(tenant.id, user.id);
        results.bookings.push(booking);

        if (config.includePayments) {
          await db.payments.create({
            id: `payment-${booking.id}`,
            bookingId: booking.id,
            amount: 100,
            status: 'completed',
          });
        }
      }
    }
  }

  return results;
}

// Usage
beforeEach(async () => {
  await seedTestEnvironment({
    tenantCount: 2,
    usersPerTenant: 5,
    bookingsPerUser: 10,
    includePayments: true,
    includeReviews: false,
  });
});
```

---

## 8. Quality Checklist

- [ ] All test data includes explicit `tenant_id`
- [ ] Test IDs are deterministic (reproducible)
- [ ] No shared state between tests
- [ ] Cleanup runs after every test
- [ ] Fixtures use builder pattern for flexibility
- [ ] Minimal data created (only what's needed)
- [ ] Setup time < 100ms per test
- [ ] Relationships maintain foreign key integrity
- [ ] Soft-deleted data handled correctly
- [ ] Tests are isolated and can run in parallel

---

## Next Steps

- **[TESTING_STRATEGY.md](./TESTING_STRATEGY.md)** — Return to testing strategy
- **[ISOLATION_TESTING.md](./ISOLATION_TESTING.md)** — Isolation verification tests
- **[Code Examples](./code-examples/testing/)** — Runnable seeding examples
