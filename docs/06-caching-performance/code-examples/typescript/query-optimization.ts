/**
 * Query Optimization: Drizzle ORM Patterns for Multi-Tenant Systems
 *
 * Demonstrates best practices for efficient database queries in multi-tenant SaaS:
 * - Tenant-scoped filtering (ALWAYS include tenant_id)
 * - Eager loading to prevent N+1 queries
 * - Projection to select only needed columns
 * - Pagination for large result sets
 * - Indexed queries for performance
 *
 * All queries follow the pattern:
 *   1. Filter by tenant_id first
 *   2. Apply business logic filters
 *   3. Use eager loading for relations
 *   4. Project only needed columns
 *   5. Paginate large result sets
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '~/db'; // Your Drizzle instance

// Type definitions for examples
interface TenantContext {
  tenantId: string;
  userId: string;
}

interface Booking {
  id: string;
  tenant_id: string;
  customer_id: string;
  staff_id: string;
  service_id: string;
  booking_date: Date;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  notes?: string;
}

interface Customer {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  phone?: string;
  created_at: Date;
}

interface Staff {
  id: string;
  tenant_id: string;
  name: string;
  position: string;
}

interface Service {
  id: string;
  tenant_id: string;
  name: string;
  duration_minutes: number;
  price: number;
}

/**
 * PATTERN 1: Basic Tenant-Scoped Query
 * ✅ ALWAYS include tenant_id in WHERE clause
 */
export async function getCustomersByTenant(
  db: Database,
  tenantId: string
): Promise<Customer[]> {
  // ❌ WRONG - Missing tenant filter
  // const customers = await db.select().from(schema.customers).all();

  // ✅ CORRECT - Always filter by tenant_id first
  const customers = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.tenant_id, tenantId))
    .all();

  return customers;
}

/**
 * PATTERN 2: Projection - Select Only Needed Columns
 * Reduces data transfer and improves performance
 */
export async function getCustomerNamesOnly(
  db: Database,
  tenantId: string
): Promise<Array<{ id: string; name: string }>> {
  // ❌ WRONG - Fetches entire row (wasted bandwidth)
  // const customers = await db
  //   .select()
  //   .from(schema.customers)
  //   .where(eq(schema.customers.tenant_id, tenantId))
  //   .all();

  // ✅ CORRECT - Project only needed columns
  const customers = await db
    .select({
      id: schema.customers.id,
      name: schema.customers.name,
    })
    .from(schema.customers)
    .where(eq(schema.customers.tenant_id, tenantId))
    .all();

  return customers;
}

/**
 * PATTERN 3: Eager Loading - Prevent N+1 Queries
 * Fetches related data in a single query
 */
export async function getBookingsWithRelations(
  db: Database,
  tenantId: string
): Promise<
  Array<{
    id: string;
    booking_date: Date;
    customer: Customer | null;
    staff: Staff | null;
    service: Service | null;
  }>
> {
  // ❌ WRONG - N+1 Query Problem
  // const bookings = await db
  //   .select()
  //   .from(schema.bookings)
  //   .where(eq(schema.bookings.tenant_id, tenantId))
  //   .all();
  //
  // // Each booking triggers another query - N+1 problem!
  // for (const booking of bookings) {
  //   const customer = await db
  //     .select()
  //     .from(schema.customers)
  //     .where(eq(schema.customers.id, booking.customer_id))
  //     .get();
  //   booking.customer = customer;
  // }

  // ✅ CORRECT - Eager load with joins (1 query total)
  const bookings = await db
    .select({
      id: schema.bookings.id,
      booking_date: schema.bookings.booking_date,
      customer: {
        id: schema.customers.id,
        name: schema.customers.name,
        email: schema.customers.email,
      },
      staff: {
        id: schema.staff.id,
        name: schema.staff.name,
      },
      service: {
        id: schema.services.id,
        name: schema.services.name,
        price: schema.services.price,
      },
    })
    .from(schema.bookings)
    .leftJoin(
      schema.customers,
      eq(schema.customers.id, schema.bookings.customer_id)
    )
    .leftJoin(schema.staff, eq(schema.staff.id, schema.bookings.staff_id))
    .leftJoin(
      schema.services,
      eq(schema.services.id, schema.bookings.service_id)
    )
    .where(eq(schema.bookings.tenant_id, tenantId))
    .all();

  return bookings;
}

/**
 * PATTERN 4: Filtering at Database Level
 * Push business logic to database instead of application memory
 */
export async function getCompletedBookings(
  db: Database,
  tenantId: string
): Promise<Booking[]> {
  // ❌ WRONG - Fetch all bookings then filter in app
  // const allBookings = await db
  //   .select()
  //   .from(schema.bookings)
  //   .where(eq(schema.bookings.tenant_id, tenantId))
  //   .all();
  //
  // const completed = allBookings.filter(b => b.status === 'completed');

  // ✅ CORRECT - Filter in SQL (reduces rows returned)
  const completed = await db
    .select()
    .from(schema.bookings)
    .where(
      and(
        eq(schema.bookings.tenant_id, tenantId),
        eq(schema.bookings.status, 'completed')
      )
    )
    .all();

  return completed;
}

/**
 * PATTERN 5: Complex Filtering with Multiple Conditions
 * Demonstrates AND/OR logic in tenant-scoped queries
 */
export async function searchBookings(
  db: Database,
  tenantId: string,
  filters: {
    startDate?: Date;
    endDate?: Date;
    status?: string;
    customerId?: string;
  }
): Promise<Booking[]> {
  const conditions = [eq(schema.bookings.tenant_id, tenantId)];

  if (filters.startDate) {
    conditions.push(
      and(
        sql`${
          schema.bookings.booking_date
        } >= ${filters.startDate.toISOString()}`,
        sql`${schema.bookings.booking_date} <= ${
          filters.endDate?.toISOString() || new Date().toISOString()
        }`
      )
    );
  }

  if (filters.status) {
    conditions.push(eq(schema.bookings.status, filters.status));
  }

  if (filters.customerId) {
    conditions.push(eq(schema.bookings.customer_id, filters.customerId));
  }

  const bookings = await db
    .select()
    .from(schema.bookings)
    .where(and(...conditions))
    .all();

  return bookings;
}

/**
 * PATTERN 6: Pagination for Large Result Sets
 * Prevents memory overflow from fetching millions of rows
 */
export async function getPaginatedBookings(
  db: Database,
  tenantId: string,
  page: number = 1,
  pageSize: number = 50
): Promise<{
  bookings: Booking[];
  total: number;
  page: number;
  pageCount: number;
}> {
  // Get total count
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.bookings)
    .where(eq(schema.bookings.tenant_id, tenantId))
    .get();

  const total = countResult?.count || 0;
  const pageCount = Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;

  // Get paginated results
  const bookings = await db
    .select()
    .from(schema.bookings)
    .where(eq(schema.bookings.tenant_id, tenantId))
    .orderBy(desc(schema.bookings.booking_date))
    .limit(pageSize)
    .offset(offset)
    .all();

  return {
    bookings,
    total,
    page,
    pageCount,
  };
}

/**
 * PATTERN 7: Sorting with Performance Considerations
 * Indexes should be on (tenant_id, sort_column) for optimal performance
 */
export async function getRecentBookings(
  db: Database,
  tenantId: string,
  limit: number = 20
): Promise<Booking[]> {
  // ✅ CORRECT - Sort on indexed column (booking_date should be indexed with tenant_id)
  const bookings = await db
    .select()
    .from(schema.bookings)
    .where(eq(schema.bookings.tenant_id, tenantId))
    .orderBy(desc(schema.bookings.booking_date))
    .limit(limit)
    .all();

  return bookings;
}

/**
 * PATTERN 8: Batch Operations - Avoid Multiple Individual Queries
 */
export async function getBookingsByCustomerIds(
  db: Database,
  tenantId: string,
  customerIds: string[]
): Promise<Booking[]> {
  // ❌ WRONG - One query per customer (N+1)
  // const bookings = [];
  // for (const customerId of customerIds) {
  //   const booking = await db
  //     .select()
  //     .from(schema.bookings)
  //     .where(
  //       and(
  //         eq(schema.bookings.tenant_id, tenantId),
  //         eq(schema.bookings.customer_id, customerId)
  //       )
  //     )
  //     .all();
  //   bookings.push(...booking);
  // }

  // ✅ CORRECT - Single query with IN clause
  const bookings = await db
    .select()
    .from(schema.bookings)
    .where(
      and(
        eq(schema.bookings.tenant_id, tenantId),
        inArray(schema.bookings.customer_id, customerIds)
      )
    )
    .all();

  return bookings;
}

/**
 * PATTERN 9: Aggregations - Count, Sum, Avg at Database Level
 * Push aggregation logic to SQL instead of application
 */
export async function getBookingStats(
  db: Database,
  tenantId: string
): Promise<{
  totalBookings: number;
  completedBookings: number;
  totalRevenue: number;
  averageServicePrice: number;
}> {
  const stats = await db
    .select({
      totalBookings: sql<number>`count(*)`,
      completedBookings: sql<number>`count(case when status = 'completed' then 1 end)`,
      totalRevenue: sql<number>`sum(${schema.services.price})`,
      avgPrice: sql<number>`avg(${schema.services.price})`,
    })
    .from(schema.bookings)
    .innerJoin(
      schema.services,
      eq(schema.services.id, schema.bookings.service_id)
    )
    .where(eq(schema.bookings.tenant_id, tenantId))
    .get();

  return {
    totalBookings: stats?.totalBookings || 0,
    completedBookings: stats?.completedBookings || 0,
    totalRevenue: stats?.totalRevenue || 0,
    averageServicePrice: stats?.avgPrice || 0,
  };
}

/**
 * PATTERN 10: Streaming Large Result Sets
 * For very large datasets, stream instead of loading all at once
 */
export async function* streamAllBookings(
  db: Database,
  tenantId: string,
  batchSize: number = 1000
): AsyncGenerator<Booking[]> {
  let offset = 0;

  while (true) {
    const batch = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.tenant_id, tenantId))
      .orderBy(asc(schema.bookings.id))
      .limit(batchSize)
      .offset(offset)
      .all();

    if (batch.length === 0) break;

    yield batch;
    offset += batchSize;
  }
}

/**
 * PATTERN 11: Update with Tenant Scope
 * Always include tenant_id in WHERE clause for updates
 */
export async function updateBookingStatus(
  db: Database,
  tenantId: string,
  bookingId: string,
  newStatus: string
): Promise<void> {
  // ✅ CORRECT - Always include tenant_id (prevents accidental cross-tenant updates)
  await db
    .update(schema.bookings)
    .set({ status: newStatus as any })
    .where(
      and(
        eq(schema.bookings.tenant_id, tenantId),
        eq(schema.bookings.id, bookingId)
      )
    )
    .execute();
}

/**
 * PATTERN 12: Delete with Tenant Scope
 * Always include tenant_id in WHERE clause for deletes
 */
export async function deleteBooking(
  db: Database,
  tenantId: string,
  bookingId: string
): Promise<number> {
  // ✅ CORRECT - Always include tenant_id (prevents accidental cross-tenant deletes)
  const result = await db
    .delete(schema.bookings)
    .where(
      and(
        eq(schema.bookings.tenant_id, tenantId),
        eq(schema.bookings.id, bookingId)
      )
    )
    .execute();

  return result.changes;
}

/**
 * Helper: Stub schema for examples
 * In reality, this would be your Drizzle schema definition
 */
const schema = {
  bookings: {} as any,
  customers: {} as any,
  staff: {} as any,
  services: {} as any,
};

/**
 * Best Practices Summary:
 *
 * 1. ✅ Always include tenant_id in WHERE clause
 * 2. ✅ Use eager loading (JOIN) instead of lazy loading
 * 3. ✅ Project only needed columns
 * 4. ✅ Filter business logic at database level
 * 5. ✅ Use pagination for large result sets
 * 6. ✅ Batch operations to reduce query count
 * 7. ✅ Push aggregations to SQL
 * 8. ✅ Create composite indexes on (tenant_id, filter_column)
 * 9. ✅ Use streaming for very large datasets
 * 10. ✅ Include tenant_id in UPDATE/DELETE WHERE clauses
 *
 * Performance Impact:
 * - Projection:     ~40% less data transfer
 * - Eager loading:  N+1 → 1 query
 * - Filtering:      99% fewer rows processed
 * - Indexes:        1000ms → 5ms query time
 * - Pagination:     Fixed memory usage
 */
