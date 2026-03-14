> **Portfolio Note:** Extracted from production system, sanitized for portfolio use.

---

# DATABASE SCHEMA ORGANIZATION GUIDE

**Purpose:** Reference for the Drizzle ORM schema structure in a multi-tenant SaaS monorepo
**Last Updated:** February 17, 2026

---

## Current Schema Structure

The schema is organized by domain under `packages/db/src/schema/`. Each domain folder contains table definitions, enums, relations, and a barrel `index.ts` export.

```
packages/db/src/schema/
+-- index.ts                         # Root barrel export
|
+-- analytics/                       # Materialized views (SQL only)
|   +-- materialized-views.sql
|
+-- auth/                            # Authentication & user identity (8 files)
|   +-- credentials.ts
|   +-- enums.ts
|   +-- index.ts
|   +-- oauth-tokens.ts
|   +-- oauth.ts
|   +-- relations.ts
|   +-- sessions.ts
|   +-- users.ts
|   +-- verifications.ts
|
+-- bookings/                        # Booking lifecycle, payments, invoicing (17 files)
|   +-- booking-history.ts               # Booking audit trail
|   +-- booking-payments.ts              # Payment records per booking
|   +-- booking-services.ts              # Booking-service junction
|   +-- booking-verifications.ts         # Booking verification codes/tokens
|   +-- bookings.ts                      # Main bookings table
|   +-- cancellation-stats.ts            # Cancellation statistics
|   +-- checkout-sessions.ts             # Stripe checkout sessions
|   +-- enums.ts                         # Booking-related enums
|   +-- index.ts
|   +-- invoice-items.ts                 # Individual invoice line items
|   +-- invoices.ts                      # Invoice records
|   +-- payment-methods.ts              # Saved payment methods
|   +-- payment-receipts.ts             # Payment receipt records
|   +-- relations.ts                     # Drizzle relations
|   +-- stripe-webhook-events.ts         # Stripe webhook event log
|   +-- tenant-tip-policies.ts           # Tip configuration per tenant
|   +-- tip-assignments.ts              # Tip allocation to staff
|
+-- customers/                       # Customer profiles (2 files)
|   +-- customer-profiles.ts
|   +-- index.ts
|
+-- files/                           # File upload management (4 files)
|   +-- enums.ts
|   +-- file-uploads.ts                  # Upload records (S3 references)
|   +-- index.ts
|   +-- relations.ts
|
+-- loyalty/                         # Loyalty program (5 files)
|   +-- index.ts
|   +-- loyalty-fund-ledger.ts           # Fund movement ledger
|   +-- loyalty-program-rules.ts         # Point/reward rules per tenant
|   +-- loyalty-transactions.ts          # Point earn/redeem transactions
|   +-- loyalty-wallets.ts               # Customer loyalty point balances
|
+-- maps/                            # Geolocation caching (5 files)
|   +-- distance-cache.ts               # Cached distance calculations
|   +-- enums.ts
|   +-- geocode-cache.ts                 # Cached geocoding results
|   +-- index.ts
|   +-- relations.ts
|
+-- notifications/                   # Notifications & email (4 files)
|   +-- email-logs.ts                    # Email send history
|   +-- enums.ts
|   +-- index.ts
|   +-- notification-preferences.ts      # User notification preferences
|
+-- post/                            # Social/content posts (2 files)
|   +-- index.ts
|   +-- post.ts
|
+-- reviews/                         # Customer reviews (6 files)
|   +-- customer-reviews.ts              # Review content and ratings
|   +-- enums.ts
|   +-- index.ts
|   +-- relations.ts
|   +-- review-attachments.ts            # Photos/media attached to reviews
|   +-- review-helpful-votes.ts          # "Was this helpful?" votes
|
+-- roles/                           # RBAC role management (6 files)
|   +-- enums.ts
|   +-- index.ts
|   +-- platform-roles.ts               # Platform-level roles
|   +-- relations.ts
|   +-- tenant-roles.ts                 # Tenant-scoped roles
|   +-- user-roles.ts                   # User-role assignments
|
+-- security/                        # Row-level security (SQL only)
|   +-- row-level-security.sql
|
+-- staff/                           # Staff management (14 files)
|   +-- enums.ts
|   +-- index.ts
|   +-- relations.ts
|   +-- schema.ts                        # Shared staff schema helpers
|   +-- staff-availability.ts            # Recurring availability windows
|   +-- staff-calendar-events.ts         # Calendar event entries
|   +-- staff-employments.ts             # Employment records
|   +-- staff-invitations.ts             # Pending staff invitations
|   +-- staff-performance.ts             # Performance metrics
|   +-- staff-profiles.ts               # Core staff profile data
|   +-- staff-salon-associations.ts      # Staff-to-business links
|   +-- staff-services.ts               # Staff-service capabilities
|   +-- staff-specializations.ts         # Specialization tags
|   +-- user-filter-presets.ts           # Saved filter presets
|
+-- tenants/                         # Tenant/business management (7 files + subfolder)
|   +-- enums.ts
|   +-- index.ts
|   +-- relations.ts
|   +-- tenant-payment-configs.ts        # Payment gateway config per tenant
|   +-- tenants.ts                       # Main tenants table
|   +-- services/                        # Tenant service catalog
|       +-- enums.ts
|       +-- index.ts
|       +-- service-categories.ts        # Service category definitions
|       +-- tenant-services.ts           # Services offered by tenants
|
+-- time-off/                        # Time-off & leave management (11 files)
|   +-- affected-bookings.ts             # Bookings affected by time-off
|   +-- compensation-offers.ts           # Compensation for affected customers
|   +-- enums.ts
|   +-- index.ts
|   +-- manager-call-logs.ts             # Manager approval call logs
|   +-- public-holidays.ts              # Public holiday definitions
|   +-- recurring-time-off.ts            # Recurring time-off patterns
|   +-- relations.ts
|   +-- time-off-approvals.ts            # Approval workflow records
|   +-- time-off-balances.ts             # Staff time-off balance tracking
|   +-- time-off-requests.ts             # Time-off request records
|
+-- views/                           # Database views (1 file)
|   +-- tenant-stats.ts                  # Materialized view for tenant statistics
|
+-- wallet/                          # Customer wallet (5 files)
    +-- customer-money-wallets.ts        # Customer monetary balance
    +-- enums.ts
    +-- index.ts
    +-- relations.ts
    +-- wallet-transactions.ts           # Wallet top-up/spend transactions
```

---

## Domain Summary

| Domain            | Files | Description                                                     |
| ----------------- | ----- | --------------------------------------------------------------- |
| **analytics**     | 1     | Materialized view SQL definitions                               |
| **auth**          | 8     | Users, sessions, OAuth, credentials, verifications              |
| **bookings**      | 17    | Bookings, payments, invoices, checkout, tips, Stripe webhooks   |
| **customers**     | 2     | Customer profile data                                           |
| **files**         | 4     | File upload tracking (S3 integration)                           |
| **loyalty**       | 5     | Loyalty program rules, wallets, transactions, fund ledger       |
| **maps**          | 5     | Geocode cache, distance cache for geolocation features          |
| **notifications** | 4     | Email logs, notification preferences                            |
| **post**          | 2     | Social/content posts                                            |
| **reviews**       | 6     | Customer reviews, attachments, helpful votes                    |
| **roles**         | 6     | Platform roles, tenant roles, user-role assignments             |
| **security**      | 1     | Row-level security SQL policies                                 |
| **staff**         | 14    | Profiles, employment, availability, calendar, invitations, etc. |
| **tenants**       | 7+4   | Tenant config, payment configs, service catalog (subfolder)     |
| **time-off**      | 11    | Time-off requests, approvals, balances, holidays, compensation  |
| **views**         | 1     | Materialized views (tenant_stats)                               |
| **wallet**        | 5     | Customer money wallets, transactions                            |

**Total: 18 domain folders, 100+ schema files**

---

## Organizational Philosophy

### 1. Group by Domain

Each folder represents a bounded domain context. Related tables, enums, and relations live together.

```
bookings/           <- All booking-related tables
loyalty/            <- All loyalty-related tables
staff/              <- All staff-related tables
```

### 2. One Table Per File

Each `.ts` file defines a single table. This keeps files small, focused, and easy to navigate.

```typescript
// bookings/bookings.ts      <- bookings table only
// bookings/invoices.ts      <- invoices table only
// bookings/tip-assignments.ts <- tip_assignments table only
```

### 3. Shared Enums in `enums.ts`

Domain-scoped enums are co-located with their domain.

```typescript
// bookings/enums.ts
export const bookingStatusEnum = pgEnum('booking_status', [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
]);
```

### 4. Relations in `relations.ts`

Drizzle ORM relation definitions are in a separate file per domain.

```typescript
// bookings/relations.ts
export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  tenant: one(tenants, { ... }),
  services: many(bookingServices),
}));
```

### 5. Barrel Exports via `index.ts`

Each domain folder re-exports its contents for clean imports.

```typescript
// bookings/index.ts
export * from './bookings';
export * from './booking-services';
export * from './enums';
export * from './relations';
// ...
```

Consumer usage:

```typescript
import { bookings, bookingStatusEnum } from '@app/db/schema/bookings';
```

---

## File Size Guidelines

```
0-300 lines     PERFECT - Keep as single file
300-500 lines   OKAY - Consider splitting if complexity warrants it
500-800 lines   WARNING - Plan to split
800+ lines      TOO BIG - Split immediately
```

---

## When to Split a Schema File

### Split when:

1. **Multiple tables in one file** - Each table should get its own file
2. **File exceeds 500 lines** - Break into logical groups
3. **Different concerns mixed** - Separate by domain responsibility

### Do NOT split when:

1. **Single table under 500 lines** - Keep as one file
2. **All columns are logically related** - No benefit from splitting
3. **Would create files under 50 lines** - Too granular

---

## File Naming Conventions

```
bookings.ts                  - Main table definition
booking-services.ts          - Junction/relationship table
booking-history.ts           - Audit trail table
enums.ts                     - Domain-scoped enum definitions
relations.ts                 - Drizzle ORM relations
index.ts                     - Barrel export
```

Avoid vague names like `data.ts`, `info.ts`, or `main.ts`.

---

## Comparison: Domain Sizes

### Large Domains (multiple tables, well-split)

```
bookings/    17 files - Bookings, payments, invoices, tips, checkout
staff/       14 files - Profiles, employment, availability, calendar
time-off/    11 files - Requests, approvals, balances, holidays
auth/         8 files - Users, sessions, OAuth, credentials
```

### Medium Domains (moderate complexity)

```
tenants/     7+4 files - Core tenant + services subfolder
roles/         6 files - Platform, tenant, and user roles
reviews/       6 files - Reviews, attachments, votes
loyalty/       5 files - Programs, wallets, transactions
maps/          5 files - Geocode and distance caching
wallet/        5 files - Customer wallets, transactions
```

### Small Domains (focused, single-purpose)

```
notifications/  4 files - Email logs, preferences
files/          4 files - Upload records
customers/      2 files - Customer profiles
post/           2 files - Content posts
views/          1 file  - Materialized views
```

---

## Best Practices Summary

✅ **DO**:

- Organize by domain (bounded context)
- One table per file
- Co-locate enums and relations with their domain
- Use barrel exports (`index.ts`)
- Keep files under 500 lines
- Use descriptive, consistent naming

❌ **DON'T**:

- Mix multiple domains in one folder
- Put unrelated tables in one file
- Bury relations in random places
- Use vague names like `data.ts`
- Create overly granular files
- Duplicate enum definitions across domains

---

**The schema organization follows industry best practices: domain-driven grouping, one table per file, co-located enums and relations, and clean barrel exports.**
