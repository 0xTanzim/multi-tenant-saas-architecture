# RFC: Platform Admin Investigation & Search API

**Status**: Implemented
**Author**: Architecture Team
**Created**: 2025-09-15
**Risk Level**: MEDIUM (admin surface, cross-tenant filtering, complex authorization)

---

## Purpose

Provide platform administrators (super_admin, admin, support) with a comprehensive investigation and search surface for global booking, tenant, and user data across all tenants. This RFC documents the API design, authorization guards, and database optimization strategy for admin investigation endpoints.

---

## Problem

Currently, platform admins have limited ability to:

- Investigate specific bookings across all tenants
- Search for users or businesses by attributes
- Audit booking history and modifications
- Monitor suspicious patterns or fraud
- Resolve customer support escalations

The platform needs a scalable admin investigation API that:

1. **Cross-tenant visibility** for admins only
2. **Field-level filtering** (date range, status, tenant, customer, staff)
3. **Efficient database queries** (composite indexes, query optimization)
4. **Comprehensive authorization** (role-based access control, audit logging)
5. **Readable sorting and pagination**

---

## API Design

### Investigation Endpoints

#### 1. Search Bookings (Admin Only)

```
GET /admin/investigations/bookings?
  tenantId=uuid &
  customerId=uuid &
  status=completed|cancelled|pending &
  dateFrom=2025-01-01 &
  dateTo=2025-12-31 &
  cursor=uuid &
  limit=50
```

**Response:**

```json
{
  "data": [
    {
      "bookingId": "uuid",
      "tenantId": "uuid",
      "tenantName": "Business Name",
      "customerId": "uuid",
      "customerName": "Customer Name",
      "customerEmail": "customer@example.com",
      "status": "completed",
      "bookingDate": "2025-06-15",
      "startTime": "14:00",
      "endTime": "15:00",
      "totalAmount": 500.0,
      "platformFeeAmount": 25.0,
      "staffCount": 2,
      "createdAt": "2025-06-10T10:30:00Z",
      "updatedAt": "2025-06-15T15:30:00Z"
    }
  ],
  "nextCursor": "uuid",
  "hasMore": true
}
```

**Authorization Guard**: `@UseGuards(AdminInvestigationGuard)`

#### 2. Get Booking Details (Admin Only)

```
GET /admin/investigations/bookings/:bookingId
```

**Returns**: Full booking record including:

- All services with staff assignments
- Payment details and fee breakdown
- Customer and staff contact information
- Review/rating information if exists
- Modification history (created, updated, cancelled timestamps with user attribution)

#### 3. Search Tenants (Admin Only)

```
GET /admin/investigations/tenants?
  name=searchQuery &
  city=oslo &
  status=active|suspended &
  cursor=uuid &
  limit=50
```

#### 4. Search Users (Admin Only)

```
GET /admin/investigations/users?
  email=user@example.com &
  tenantId=uuid &
  role=owner|manager|staff|customer &
  cursor=uuid &
  limit=50
```

---

## Database Optimization Strategy

### Indexes Required

```sql
-- Booking investigations
CREATE INDEX idx_bookings_tenant_date_status
  ON bookings(tenant_id, booking_date DESC, status)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_bookings_customer_tenant
  ON bookings(customer_id, tenant_id, booking_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_bookings_status_date
  ON bookings(status, booking_date DESC)
  WHERE deleted_at IS NULL;

-- Tenant investigations
CREATE INDEX idx_tenants_city_status
  ON tenants(city, status)
  WHERE deleted_at IS NULL;

-- User investigations
CREATE INDEX idx_users_email_status
  ON users(email, status)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_users_tenant_role
  ON users(tenant_id, role)
  WHERE deleted_at IS NULL;
```

### Query Optimization Approach

1. **Composite indexes first** — combine frequently-filtered columns
2. **Date range optimization** — booking_date DESC for reverse chronological
3. **Soft delete filter** — add WHERE deleted_at IS NULL to all indexes
4. **Cursor pagination** — avoid OFFSET, use cursor-based pagination
5. **SELECT specific columns** — don't SELECT \* for large result sets

---

## Foreign Key Chain Analysis

For investigating a booking, admins must understand the full relational context:

```
booking
├── FK → tenant (tenant_id)
├── FK → customer_profile → user (customer_id)
├── FK → staff_employment (primary_staff_employment_id) → staff_profile → user
└── booking_services[]
    ├── FK → service (service_id)
    ├── FK → staff_employment
    └── FK → service_category
```

**Admin investigation controller must LEFT JOIN all related tables** to provide a 360-view of the booking.

---

## Authorization Pattern

```typescript
@UseGuards(AdminInvestigationGuard)
@Get('bookings/:bookingId')
async getBookingDetail(
  @Param('bookingId') bookingId: string,
  @CurrentUser() admin: JwtPayload,
) {
  // Guard ensures: admin.platformRole in ['super_admin', 'admin', 'support']
  // Controller: no tenant_id filtering (cross-tenant visibility for admins)

  const booking = await this.bookingRepository.findById(bookingId);

  // Audit log this access
  await this.auditService.log({
    adminId: admin.sub,
    action: 'investigation_booking_view',
    resourceId: bookingId,
    timestamp: new Date(),
  });

  return booking;
}
```

---

## Service Layer Responsibility

The investigation service handles:

1. **Query construction** — translate filter params to SQL WHERE clauses
2. **Cursor pagination** — encode/decode cursor state
3. **FK resolution** — load related tenant, customer, staff, services
4. **Result mapping** — DTO transformation for API response
5. **Audit logging** — record admin investigation access

```typescript
async searchBookings(filters: BookingInvestigationFilters, cursor?: string): Promise<{
  data: BookingInvestigationDto[];
  nextCursor?: string;
  hasMore: boolean;
}> {
  // 1. Parse cursor (or start from beginning)
  const offset = this.decodeCursor(cursor) || 0;

  // 2. Build WHERE clauses from filters
  const whereConditions = this.buildWhereClause(filters);

  // 3. Query with composite index utilization
  const bookings = await this.db.select()
    .from(bookingsTable)
    .where(whereConditions)
    .orderBy(desc(bookingsTable.bookingDate))
    .limit(51)  // Fetch +1 to check hasMore
    .offset(offset);

  // 4. Determine hasMore and nextCursor
  const hasMore = bookings.length > 50;
  const data = bookings.slice(0, 50);
  const nextCursor = hasMore ? this.encodeCursor(offset + 50) : undefined;

  // 5. Load related data (tenant, customer, staff) via repository joins
  const enriched = await Promise.all(
    data.map(b => this.enrichBookingData(b))
  );

  return {
    data: enriched.map(b => this.toInvestigationDto(b)),
    nextCursor,
    hasMore,
  };
}
```

---

## Performance Considerations

1. **N+1 Prevention** — use LEFT JOIN in initial query, not separate queries per booking
2. **Index hit rate** — test queries with EXPLAIN to confirm index usage
3. **Query timeouts** — set 5-second limit on admin queries to prevent runaway scans
4. **Cache-free design** — investigation data must always be fresh (no Redis caching)
5. **Pagination limit** — enforce max 100 results per page to prevent memory exhaustion

---

## Audit Logging

Every admin investigation access is logged:

```typescript
{
  adminId: "user-uuid",
  adminEmail: "admin@platform.com",
  action: "investigation_booking_view",
  resourceType: "booking",
  resourceId: "booking-uuid",
  resourceTenantId: "tenant-uuid",
  timestamp: "2025-06-15T10:30:00Z",
  ipAddress: "192.168.1.1",
  userAgent: "Mozilla/5.0...",
}
```

These logs are queryable by admins for compliance audits.

---

## Summary

The admin investigation API provides:

- **Cross-tenant visibility** for authorized admins
- **Efficient filtering** via composite indexes and query optimization
- **Complete FK chain loading** for 360-view investigation
- **Audit trail** of all admin access
- **Cursor-based pagination** for scalable result sets
- **Authorization guards** to enforce role-based access

This design allows support teams and admins to quickly investigate booking issues, audit changes, and resolve customer escalations without architectural complexity.
