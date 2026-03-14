# RFC: Multi-Location & Widget Ecosystem Research

**Status**: Architecture Research & Design
**Author**: Product & Platform Team
**Created**: 2025-10-15
**Scope**: Future platform evolution toward multi-location enterprise support and embeddable widget ecosystem

---

## Purpose

This RFC documents architectural research for two major platform evolution efforts:

1. **Multi-Location Support** — Enabling service provider businesses to manage multiple physical locations
2. **Widget Ecosystem** — Embeddable booking widgets for third-party integration

Both features are designed to increase platform reach, support enterprise scaling, and enable partnership monetization.

---

## Part 1: Multi-Location Architecture

### The Question: Sub-Tenants vs. Locations?

**Option A: Locations as Sub-Tenants**

Create a new `tenant_type: "location"` and new tenant for each location.

```
Platform Tenant (Super, type='organization')
├── Location A Tenant (Sub, type='location', parent_tenant_id=platform)
├── Location B Tenant (Sub, type='location', parent_tenant_id=platform)
└── Location C Tenant (Sub, type='location', parent_tenant_id=platform)
```

**Pros:**

- Complete isolation per location (strict data boundaries)
- Scalable independently (separate billing, subscriptions)
- Simplest schema (no new fields)

**Cons:**

- Massive schema duplication (50+ tables × 3 locations = 150 tables)
- Operational complexity (manage 3 separate environments)
- Business model breaks (customers see 3 separate "businesses")
- Staff context explosion (employee with 3 location tenants = 3 authentication contexts)

**Decision:** ❌ REJECTED — Not viable

---

**Option B: Locations as Organizational Layer (CHOSEN)**

Add `locations` table as a owned-resource within single tenant.

```
Tenant (single tenant, all locations share data context)
├── Location A (address, phone, hours, staff assignments)
├── Location B (address, phone, hours, staff assignments)
└── Location C (address, phone, hours, staff assignments)

Staff Employment
├── Staff A: employed_at_location_ids = [A, B]  (multi-location staff)
├── Staff B: employed_at_location_ids = [C]     (single location)
└── Staff C: employed_at_location_ids = [A, B, C] (all locations)

Service
├── Service 1: available_at_location_ids = [A, B]   (not at C)
├── Service 2: available_at_location_ids = [A, B, C] (everywhere)
```

**Pros:**

- Single tenant context (no authentication complexity)
- Minimal schema expansion (add locations table + location_id FKs)
- Customers book across locations under same business
- Staff seamlessly work multiple locations
- Unified billing and reporting

**Cons:**

- Location data somewhat denormalized (address stored in 2 places if also in bookings)
- Query filters need location context (WHERE location_id IN (A, B))

**Decision:** ✅ ACCEPTED — Pragmatic, minimal disruption

---

### Schema Expansion for Multi-Location

```sql
-- New table: locations
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  name VARCHAR(200) NOT NULL,  -- "Downtown Branch", "Airport Location"
  slug VARCHAR(50) NOT NULL,   -- "downtown", "airport"
  address_line1 VARCHAR(255) NOT NULL,
  address_line2 VARCHAR(255),
  city VARCHAR(100) NOT NULL,
  state_province VARCHAR(50),
  postal_code VARCHAR(20),
  country_code VARCHAR(2),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),

  phone_number VARCHAR(20),
  email VARCHAR(255),

  opening_hours JSONB,  -- {"monday": {"opens": "09:00", "closes": "18:00"}, ...}
  is_active BOOLEAN DEFAULT true,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(tenant_id, slug),
  INDEX idx_locations_tenant (tenant_id),
  INDEX idx_locations_active (tenant_id, is_active)
);

-- Modify existing tables
ALTER TABLE staff_employment ADD COLUMN location_ids UUID[] DEFAULT ARRAY[]::UUID[];
ALTER TABLE services ADD COLUMN location_ids UUID[] DEFAULT ARRAY[]::UUID[];
ALTER TABLE bookings ADD COLUMN location_id UUID REFERENCES locations(id);
ALTER TABLE booking_time_slots ADD COLUMN location_id UUID REFERENCES locations(id);
```

### Data Query Impact

```typescript
// Previously: "Get all services for tenant"
const services = await serviceRepository.findByTenant(tenantId);

// Now: "Get all services available at location"
const services = await serviceRepository.findByTenantAndLocation(
  tenantId,
  locationId
);
// WHERE tenant_id = $1 AND $2 = ANY(location_ids)

// Or: "Get services available at multiple locations"
const services = await serviceRepository.findByTenantAndLocations(tenantId, [
  locationA,
  locationB,
]);
// WHERE tenant_id = $1 AND location_ids && ARRAY[$2, $3]
```

### Staff Context Resolution

```typescript
// User "Alice" is employed at multiple locations
// When she logs in, query to find her active employments:

const employments = await staffEmploymentRepository.findActiveByUser(userId);
// Returns: [
//   { id: 'emp-1', tenantId: 'tenant-1', locationIds: ['loc-a', 'loc-b'] },
//   { id: 'emp-2', tenantId: 'tenant-2', locationIds: ['loc-c'] },
// ]

// She chooses to work at tenant-1 on this shift
// Context resolves to: activeLocations = ['loc-a', 'loc-b']

// In her calendar view, she can filter by specific location or see all
const bookings = await bookingRepository.findByStaffAndLocations(
  staffId,
  ['loc-a', 'loc-b'], // Scoped to her work locations
  dateRange
);
```

### Migration Effort Estimate

| Task                         | Effort                   | Risk   |
| ---------------------------- | ------------------------ | ------ |
| Schema migration             | 8 hours                  | LOW    |
| Repository query updates     | 16 hours                 | MEDIUM |
| Service layer updates        | 12 hours                 | MEDIUM |
| API endpoint updates         | 10 hours                 | LOW    |
| Frontend UI updates          | 40 hours                 | MEDIUM |
| Testing (unit + integration) | 24 hours                 | MEDIUM |
| **Total**                    | **110 hours (~3 weeks)** |        |

### Important Constraint: Business Model Impact

**Current:** One tenant = one subscription tier subscription.
**Future Multi-Location:** Need to decide:

- **Option 1:** Single subscription covers unlimited locations
- **Option 2:** Per-location subscription add-on (pricing multiplier)
- **Option 3:** Tiered by location count (0-5 free locations, then pay per location)

This decision must precede implementation to avoid rework.

---

## Part 2: Widget Ecosystem

### The Vision: Embeddable Service Booking

Enable third-party websites (fitness studios, gyms, beauty supply retailers) to embed service booking directly on their site.

```html
<!-- Third-party website: www.yogastudio.com -->
<body>
  <h1>Book Your Class</h1>
  <iframe src="https://platform.com/widgets/booking?key=xyz" />
</body>
```

User books directly on partner's site → booking appears in partner's platform dashboard → revenue share.

### Widget Architecture

#### 1. Widget API Key Management

```sql
CREATE TABLE widget_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),

  key_value VARCHAR(100) UNIQUE NOT NULL,  -- public key
  secret_value VARCHAR(100) UNIQUE NOT NULL,  -- secret key

  domain_allowlist TEXT[],  -- ["yogastudio.com", "*.yogastudio.com"]

  config JSONB,  -- {
              --   "colors": {"primary": "#FF6B6B", "accent": "#FFA500"},
              --   "language": "en",
              --   "showReviews": true,
              --   "featuresAllowed": ["search", "book", "payment"]
              -- }

  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_widget_keys_tenant (tenant_id)
);

CREATE TABLE widget_embeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_key_id UUID NOT NULL REFERENCES widget_api_keys(id),

  embed_url VARCHAR(500),  -- https://yogastudio.com/book
  embed_page_title VARCHAR(255),

  traffic_total INT DEFAULT 0,
  bookings_generated INT DEFAULT 0,
  revenue_total DECIMAL(12, 2) DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 2. Widget Endpoints

```
GET /widgets/booking/iframe?key=xyz&serviceId=abc&theme=light
```

Returns responsive iframe for embedding:

```html
<iframe
  src="https://platform.com/widgets/booking/iframe?key=xyz"
  width="100%"
  height="600"
  frameborder="0"
  allow="payment"
/>
```

#### 3. Widget Analytics

Track:

- Page views (impressions)
- Search queries
- Booking conversions
- Revenue generated
- User source/location

```sql
CREATE TABLE widget_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_key_id UUID NOT NULL REFERENCES widget_api_keys(id),

  event_type VARCHAR(20),  -- "impression", "search", "booking_started", "booking_completed"
  event_date DATE NOT NULL,

  count INT DEFAULT 1,
  revenue_impact DECIMAL(10, 2) DEFAULT 0,

  metadata JSONB,  -- {"serviceCategory": "yoga", "location": "US"}

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_analytics_date (event_date, widget_key_id)
);
```

#### 4. Revenue Sharing Model

**Example:** Partner books $100 service through widget

```
Gross booking value:        $100.00
Platform fee (-2%):          -$2.00
Subtotal for partner:        $98.00
Revenue share to platform:    $5.00  (platform.revenue_share_percent from tenant config)
Net to partner:              $93.00
```

### Widget Builder (Future Phase)

Self-service widget customization interface:

```tsx
// Partner logs into dashboard
// → Go to Integrations → Create Widget
// → Configure:
//   - Name: "Book a Service"
//   - Colors: Primary/Accent
//   - Services to show
//   - Custom branding
//   - Domain allowlist
// → Get embed code
// → Paste on website
```

### Implementation Roadmap

| Phase   | Timeline | Scope                   | Effort   |
| ------- | -------- | ----------------------- | -------- |
| Phase 1 | Q4 2025  | API keys + basic iframe | 80 hours |
| Phase 2 | Q1 2026  | Widget analytics        | 40 hours |
| Phase 3 | Q2 2026  | Widget builder UI       | 60 hours |
| Phase 4 | Q3 2026  | Mobile responsiveness   | 30 hours |
| Phase 5 | Q4 2026  | Revenue share reporting | 20 hours |

---

## Subscription Tier Feature Entitlement

Multi-location and widgets are available by subscription tier:

| Feature          | Free | Starter | Professional | Enterprise |
| ---------------- | ---- | ------- | ------------ | ---------- |
| Locations        | 1    | 1       | 5            | Unlimited  |
| Widgets          | —    | —       | 1            | 5          |
| Widget analytics | —    | —       | Basic        | Advanced   |
| Revenue share    | —    | —       | 3%           | Negotiable |

---

## Summary

### Multi-Location: Core Architecture Decision

✅ **Locations as organizational layer** (not sub-tenants)

Benefits:

- Single tenant context
- Minimal schema disruption (1 new table, 3 FK additions)
- Unified business identity
- 110-hour implementation effort

### Widget Ecosystem: Revenue Expansion

✅ **Embeddable iframe widgets** enable partnerships

Benefits:

- Third-party booking integration
- Revenue sharing model
- Analytics for partners
- Scalable without new infrastructure

Both features position the platform for enterprise adoption and recurring partnership revenue.
