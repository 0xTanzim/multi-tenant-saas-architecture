/**
 * End-to-End Multi-Tenant Test
 *
 * This example demonstrates a complete E2E test flow with multiple tenants,
 * including data creation, operations, isolation verification, and cleanup.
 *
 * Usage:
 * npm test -- e2e-multi-tenant.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

/**
 * Mock types - replace with actual implementations
 */
interface Tenant {
  id: string;
  name: string;
  plan: string;
  status: 'active' | 'inactive';
}

interface User {
  id: string;
  tenantId: string;
  email: string;
  role: 'admin' | 'staff' | 'customer';
  status: 'active' | 'inactive';
}

interface Booking {
  id: string;
  tenantId: string;
  customerId: string;
  startTime: Date;
  endTime: Date;
  status: 'confirmed' | 'cancelled' | 'completed';
  price: number;
}

/**
 * Mock database layer
 */
class MockBookingDatabase {
  private bookings: Map<string, Booking[]> = new Map();

  async create(booking: Booking): Promise<Booking> {
    if (!this.bookings.has(booking.tenantId)) {
      this.bookings.set(booking.tenantId, []);
    }
    this.bookings.get(booking.tenantId)!.push(booking);
    return booking;
  }

  async findByTenantId(tenantId: string): Promise<Booking[]> {
    return this.bookings.get(tenantId) || [];
  }

  async findById(id: string, tenantId: string): Promise<Booking | null> {
    const bookings = this.bookings.get(tenantId) || [];
    return bookings.find((b) => b.id === id) || null;
  }

  async delete(id: string, tenantId: string): Promise<void> {
    const bookings = this.bookings.get(tenantId) || [];
    const index = bookings.findIndex((b) => b.id === id);
    if (index > -1) {
      bookings.splice(index, 1);
    }
  }

  async clear(): Promise<void> {
    this.bookings.clear();
  }
}

/**
 * Mock booking service
 */
class BookingService {
  constructor(private db: MockBookingDatabase) {}

  async createBooking(
    customerId: string,
    tenantId: string,
    data: Partial<Booking>
  ): Promise<Booking> {
    const booking: Booking = {
      id: `booking-${Date.now()}-${Math.random()}`,
      tenantId,
      customerId,
      startTime: data.startTime || new Date(),
      endTime: data.endTime || new Date(Date.now() + 3600000),
      status: data.status || 'confirmed',
      price: data.price || 0,
    };

    return this.db.create(booking);
  }

  async listBookings(tenantId: string): Promise<Booking[]> {
    return this.db.findByTenantId(tenantId);
  }

  async getBooking(id: string, tenantId: string): Promise<Booking | null> {
    return this.db.findById(id, tenantId);
  }

  async cancelBooking(id: string, tenantId: string): Promise<void> {
    const booking = await this.getBooking(id, tenantId);
    if (booking) {
      booking.status = 'cancelled';
      await this.db.delete(id, tenantId);
      await this.db.create(booking);
    }
  }
}

/**
 * Test Data Factory
 */
class TestDataFactory {
  constructor(private testName: string) {}

  createTenantId(index: number = 0): string {
    return `tenant-e2e-test-${this.testName}-${index}`;
  }

  createUserId(index: number): string {
    return `user-e2e-test-${this.testName}-${index}`;
  }

  createBookingId(index: number): string {
    return `booking-e2e-test-${this.testName}-${index}`;
  }
}

/**
 * E2E Tests: Multi-Tenant Booking Flow
 */
describe('E2E: Multi-Tenant Booking System', () => {
  let db: MockBookingDatabase;
  let bookingService: BookingService;
  let factory: TestDataFactory;

  // Test data
  let tenant1: { id: string; admin: string };
  let tenant2: { id: string; admin: string };

  beforeEach(async () => {
    // Setup
    db = new MockBookingDatabase();
    bookingService = new BookingService(db);
    factory = new TestDataFactory('booking-e2e');

    // Create tenants
    tenant1 = {
      id: factory.createTenantId(1),
      admin: factory.createUserId(1),
    };

    tenant2 = {
      id: factory.createTenantId(2),
      admin: factory.createUserId(2),
    };
  });

  afterEach(async () => {
    // Cleanup
    await db.clear();
  });

  /**
   * Test 1: Tenant can create and retrieve their own bookings
   */
  test('tenant1 can create and retrieve their bookings', async () => {
    // Setup: Create bookings for tenant1
    const booking1 = await bookingService.createBooking(
      factory.createUserId(100),
      tenant1.id,
      { price: 100 }
    );

    const booking2 = await bookingService.createBooking(
      factory.createUserId(101),
      tenant1.id,
      { price: 150 }
    );

    // Execute: List bookings for tenant1
    const bookings = await bookingService.listBookings(tenant1.id);

    // Assert: Should have both bookings
    expect(bookings).toHaveLength(2);
    expect(bookings.map((b) => b.id)).toContain(booking1.id);
    expect(bookings.map((b) => b.id)).toContain(booking2.id);
  });

  /**
   * Test 2: Tenant1 cannot see Tenant2's bookings
   */
  test('tenant1 cannot access tenant2 bookings', async () => {
    // Setup: Create bookings in both tenants
    const t1Booking = await bookingService.createBooking(
      factory.createUserId(100),
      tenant1.id,
      { price: 100 }
    );

    const t2Booking = await bookingService.createBooking(
      factory.createUserId(200),
      tenant2.id,
      { price: 200 }
    );

    // Execute: Query as tenant1
    const t1Results = await bookingService.listBookings(tenant1.id);

    // Assert: Should only see tenant1 booking
    expect(t1Results).toHaveLength(1);
    expect(t1Results[0].id).toBe(t1Booking.id);

    // Critical: Should NOT see tenant2 booking
    const bookingIds = t1Results.map((b) => b.id);
    expect(bookingIds).not.toContain(t2Booking.id);
  });

  /**
   * Test 3: Cross-tenant booking retrieval is blocked
   */
  test('tenant1 cannot retrieve tenant2 booking directly', async () => {
    // Setup: Create booking in tenant2
    const booking = await bookingService.createBooking(
      factory.createUserId(200),
      tenant2.id,
      { price: 200 }
    );

    // Execute: Attempt to retrieve as tenant1
    const result = await bookingService.getBooking(booking.id, tenant1.id);

    // Assert: Should return null (not found for this tenant)
    expect(result).toBeNull();
  });

  /**
   * Test 4: Each tenant's data remains independent
   */
  test('multiple tenants can operate simultaneously without interference', async () => {
    // Simulate concurrent operations from two tenants
    const operations = await Promise.all([
      // Tenant1 operations
      (async () => {
        const b1 = await bookingService.createBooking(
          factory.createUserId(100),
          tenant1.id,
          { price: 100 }
        );
        const b2 = await bookingService.createBooking(
          factory.createUserId(101),
          tenant1.id,
          { price: 120 }
        );
        return {
          tenantId: tenant1.id,
          bookings: [b1, b2],
        };
      })(),

      // Tenant2 operations
      (async () => {
        const b1 = await bookingService.createBooking(
          factory.createUserId(200),
          tenant2.id,
          { price: 200 }
        );
        const b2 = await bookingService.createBooking(
          factory.createUserId(201),
          tenant2.id,
          { price: 250 }
        );
        return {
          tenantId: tenant2.id,
          bookings: [b1, b2],
        };
      })(),
    ]);

    // Verify each tenant only sees their bookings
    for (const result of operations) {
      const bookings = await bookingService.listBookings(result.tenantId);

      expect(bookings).toHaveLength(2);
      bookings.forEach((b) => {
        expect(b.tenantId).toBe(result.tenantId);
        expect(result.bookings.map((rb) => rb.id)).toContain(b.id);
      });
    }
  });

  /**
   * Test 5: Booking cancellation is tenant-scoped
   */
  test('tenant can only cancel their own bookings', async () => {
    // Setup: Create bookings in both tenants
    const t1Booking = await bookingService.createBooking(
      factory.createUserId(100),
      tenant1.id,
      { status: 'confirmed', price: 100 }
    );

    const t2Booking = await bookingService.createBooking(
      factory.createUserId(200),
      tenant2.id,
      { status: 'confirmed', price: 200 }
    );

    // Execute: Tenant1 cancels their booking
    await bookingService.cancelBooking(t1Booking.id, tenant1.id);

    // Assert: Tenant1's booking is cancelled
    const t1After = await bookingService.listBookings(tenant1.id);
    expect(t1After).toHaveLength(1);
    expect(t1After[0].status).toBe('cancelled');

    // Assert: Tenant2's booking is unaffected
    const t2After = await bookingService.listBookings(tenant2.id);
    expect(t2After).toHaveLength(1);
    expect(t2After[0].status).toBe('confirmed');
  });

  /**
   * Test 6: Verify no cross-tenant data leakage under load
   */
  test('concurrent operations maintain tenant isolation', async () => {
    const bookingsPerTenant = 10;
    const concurrentRequests = 50;

    // Create initial bookings
    const t1Bookings = await Promise.all(
      Array.from({ length: bookingsPerTenant }, (_, i) =>
        bookingService.createBooking(
          factory.createUserId(100 + i),
          tenant1.id,
          { price: 100 + i }
        )
      )
    );

    const t2Bookings = await Promise.all(
      Array.from({ length: bookingsPerTenant }, (_, i) =>
        bookingService.createBooking(
          factory.createUserId(200 + i),
          tenant2.id,
          { price: 200 + i }
        )
      )
    );

    // Concurrent queries from both tenants
    const queryPromises = Array.from({ length: concurrentRequests }, (_, i) => {
      const tenantId = i % 2 === 0 ? tenant1.id : tenant2.id;
      return bookingService.listBookings(tenantId);
    });

    const results = await Promise.all(queryPromises);

    // Verify isolation in all results
    results.forEach((bookings, index) => {
      const expectedTenantId = index % 2 === 0 ? tenant1.id : tenant2.id;
      const expectedCount = bookingsPerTenant;

      expect(bookings).toHaveLength(expectedCount);
      bookings.forEach((b) => {
        expect(b.tenantId).toBe(expectedTenantId);
      });
    });
  });

  /**
   * Test 7: Performance consistency across tenants
   */
  test('query performance is consistent across tenants', async () => {
    const bookingCount = 100;

    // Populate both tenants
    await Promise.all(
      Array.from({ length: bookingCount }, (_, i) =>
        bookingService.createBooking(
          factory.createUserId(100 + i),
          tenant1.id,
          { price: 100 + i }
        )
      )
    );

    await Promise.all(
      Array.from({ length: bookingCount }, (_, i) =>
        bookingService.createBooking(
          factory.createUserId(200 + i),
          tenant2.id,
          { price: 200 + i }
        )
      )
    );

    // Measure query times
    const start1 = performance.now();
    await bookingService.listBookings(tenant1.id);
    const time1 = performance.now() - start1;

    const start2 = performance.now();
    await bookingService.listBookings(tenant2.id);
    const time2 = performance.now() - start2;

    // Both should be similarly fast (within 50% of each other)
    const ratio = Math.max(time1, time2) / Math.min(time1, time2);
    expect(ratio).toBeLessThan(1.5);

    console.log(
      `Tenant1 query: ${time1.toFixed(2)}ms, Tenant2 query: ${time2.toFixed(
        2
      )}ms`
    );
  });
});
