# Developer Project Guide: Multi-Tenant Service Booking Platform

**Version**: 2.0
**Last Updated**: 2025-10-15
**Status**: Active

---

## 1. Architecture Overview

The platform is built as a modern full-stack web application with PWA (Progressive Web App) capabilities:

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js 14+)                 │
│              React, TypeScript, Tailwind CSS                  │
│         App Router, React Query, Zustand State                │
└─────────────────────────────────────────────────────────────┘
                            ↕ (REST API)
┌─────────────────────────────────────────────────────────────┐
│                   Backend (NestJS)                            │
│         TypeScript, Dependency Injection Pattern              │
│         Drizzle ORM, PostgreSQL Database                      │
└─────────────────────────────────────────────────────────────┘
                            ↕ (SQL)
┌─────────────────────────────────────────────────────────────┐
│                   Database (PostgreSQL)                       │
│         Multi-Tenant Schema, Row-Level Security               │
└─────────────────────────────────────────────────────────────┘
```

### Key Technology Stack

| Layer            | Technology               | Purpose                              |
| ---------------- | ------------------------ | ------------------------------------ |
| Frontend         | Next.js 14+ (App Router) | Server-rendered React application    |
| State Management | React Query + Zustand    | Server state + local state           |
| Styling          | Tailwind CSS v4          | Utility-first CSS framework          |
| Backend          | NestJS                   | TypeScript backend framework         |
| ORM              | Drizzle ORM              | Type-safe database abstraction       |
| Database         | PostgreSQL 15+           | Primary data store                   |
| Cache            | Redis                    | Session cache, pub/sub for real-time |
| Job Queue        | BullMQ                   | Async task processing                |
| Auth             | JWT + Sessions           | Token-based and session-based auth   |
| Payments         | Stripe API               | Payment processing                   |
| Real-Time        | WebSockets               | Live notifications, messaging        |

---

## 2. User Roles & Panels

### Role Definitions

| Role                       | Access Level            | Primary Panels               | Use Cases                      |
| -------------------------- | ----------------------- | ---------------------------- | ------------------------------ |
| **Customer**               | End-user                | My Bookings, Search, Reviews | Book services, manage bookings |
| **Service Provider Owner** | Full business access    | Dashboard, Staff, Analytics  | Manage business operations     |
| **Staff Member**           | Limited business access | Schedule, Assigned Bookings  | Manage own bookings            |
| **Platform Admin**         | Super-admin             | Admin Panel, All Data        | Moderate, manage tenants       |

### Navigation Panels

#### Customer Panel (`/my/*`)

- Dashboard (overview)
- My Bookings (list, detail, reschedule)
- Browse Services (search, filter)
- Favorites (saved providers)
- Loyalty (memberships, points)
- Wallet (payment methods, balance)
- Profile (personal info)
- Settings (notifications, preferences)

#### Provider Panel (`/dashboard/*`)

- Calendar (staff schedule)
- Bookings (manage appointments)
- Staff Management (team)
- Services (catalog)
- Customers (customer database)
- Payments (financials)
- Reports (analytics)
- Settings (business config)
- Profile (business info)

#### Admin Panel (`/admin/*`)

- Tenants (manage providers)
- Users (moderation)
- Analytics (platform metrics)
- Reports (revenue, usage)
- Disputes (resolution)
- System (configuration)

---

## 3. Core Features & Workflows

### 3.1 Service Discovery & Booking

```
User Flow:
1. Customer navigates to search page
2. Searches by service or provider name
3. Filters by location, rating, availability
4. Views provider profile and reviews
5. Selects service, date, time slot
6. (Optional) Selects preferred staff member
7. Reviews booking summary and pricing
8. Completes payment via Stripe
9. Receives confirmation (email + in-app + SMS)
10. Joins provider's queue (real-time)
```

### 3.2 Staff Management

```
Provider Workflow:
1. Owner adds staff members to business
2. Assigns services each staff provides
3. Sets availability (hours, days, vacation)
4. Staff can view assigned bookings
5. Staff marks bookings complete or no-show
6. Platform tracks staff ratings separately
```

### 3.3 Real-Time Notifications

```
Event Flow:
1. New booking created
2. Backend emits "booking.created" event
3. Redis pub/sub broadcasts to provider
4. Staff receives in-app notification
5. SMS/Email sent based on preferences
6. WebSocket pushes update to provider dashboard
```

### 3.4 Payment Processing

```
Payment Flow:
1. Customer initiates booking
2. Frontend calls Stripe API client-side (tokenization)
3. Backend receives payment token
4. Backend charges customer via Stripe API
5. Stripe webhook confirms payment
6. Backend creates booking + emits event
7. Funds deducted from platform fee + sent to provider
```

### 3.5 Multi-Tenant Data Isolation

```
Isolation Rules:
- Every query includes WHERE tenant_id = ?
- Logged-in user's tenant_id passed via context
- Middleware validates tenant access
- Row-Level Security (RLS) policies enforce at DB level
- Composite indexes on (tenant_id, ...) for performance
```

---

## 4. Business Operations

### 4.1 Subscription Model

**B2B (Provider Subscription):**

- Free tier: basic features
- Starter ($99/mo): 10 staff, SMS notifications
- Professional ($299/mo): 50 staff, advanced reports, API access
- Enterprise (custom): unlimited, dedicated support

**B2C (Customer Membership):**

- Customers can purchase loyalty packages (Gold, Silver, Bronze)
- 15% revenue share split between platform and provider
- Discount applied automatically at checkout

### 4.2 Revenue Model

```
Platform Revenue:
├── Subscription fees from providers (MRR)
├── 15% commission on customer memberships
└── Payment processing fees (~2.9% + $0.30 per transaction)
```

### 4.3 Analytics & Reporting

- Dashboard KPIs (bookings/day, revenue, active users)
- Provider analytics (staff performance, customer retention)
- Platform analytics (churn, LTV, CAC)

---

## 5. Technical Patterns

### 5.1 Database Schema Pattern

```sql
-- Multi-tenant isolation via tenant_id
CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),  -- Mandatory
  customer_id UUID NOT NULL REFERENCES users(id),
  service_id UUID NOT NULL REFERENCES services(id),

  status VARCHAR(20),  -- "pending", "confirmed", "completed", "cancelled"
  scheduled_at TIMESTAMP NOT NULL,
  duration_minutes INT NOT NULL,

  -- Tenant-scoped composite index
  INDEX idx_bookings_tenant_scheduled (tenant_id, scheduled_at)
);

-- Soft delete for audit trail
ALTER TABLE bookings ADD COLUMN deleted_at TIMESTAMP;
```

### 5.2 Repository Pattern (Drizzle ORM)

```typescript
@Injectable()
export class BookingRepository {
  constructor(private db: Database) {}

  async create(data: CreateBookingDTO, tenantId: string) {
    return this.db
      .insert(bookings)
      .values({
        ...data,
        tenant_id: tenantId,
      })
      .returning();
  }

  async findByTenant(tenantId: string, filters: FiltersDTO) {
    return this.db
      .select()
      .from(bookings)
      .where(eq(bookings.tenant_id, tenantId))
      .orderBy(desc(bookings.scheduled_at))
      .limit(50);
  }
}
```

### 5.3 Service Layer Pattern

```typescript
@Injectable()
export class BookingService {
  constructor(
    private bookingRepository: BookingRepository,
    private paymentService: PaymentService,
    private eventService: EventService,
  ) {}

  async createBooking(input: CreateBookingDTO, user: User) {
    // 1. Validate input
    const validation = validateBookingInput(input);
    if (!validation.isValid) throw new ValidationException(...);

    // 2. Check availability
    const isAvailable = await this.checkAvailability(input);
    if (!isAvailable) throw new UnavailableException();

    // 3. Process payment
    const payment = await this.paymentService.charge(input.amount, user);
    if (!payment.success) throw new PaymentException();

    // 4. Create booking
    const booking = await this.bookingRepository.create(
      input,
      user.tenantId
    );

    // 5. Emit events
    this.eventService.emit('booking.created', booking);

    return booking;
  }
}
```

### 5.4 API Controller Pattern

```typescript
@Controller('bookings')
@UseGuards(AuthGuard)
export class BookingController {
  constructor(private bookingService: BookingService) {}

  @Post()
  async create(@Body() input: CreateBookingDTO, @CurrentUser() user: User) {
    // Tenant context automatically validated by middleware
    const booking = await this.bookingService.createBooking(input, user);
    return { data: booking };
  }

  @Get()
  async list(@Query() filters: ListBookingsDTO, @CurrentUser() user: User) {
    const bookings = await this.bookingService.listByTenant(user.tenantId);
    return { data: bookings };
  }
}
```

---

## 6. Frontend Architecture

### 6.1 File Structure

```
apps/web
├── src
│   ├── app              (Next.js App Router)
│   │   ├── (auth)       (authentication routes)
│   │   ├── (customer)   (/my/* customer routes)
│   │   ├── (dashboard)  (/dashboard/* provider routes)
│   │   ├── (admin)      (/admin/* admin routes)
│   │   └── layout.tsx
│   ├── components       (reusable React components)
│   │   ├── ui          (primitives: Button, Input, etc.)
│   │   ├── forms       (form containers)
│   │   ├── layouts     (page layouts)
│   │   └── features    (feature-specific components)
│   ├── hooks            (custom React hooks)
│   ├── lib              (utilities, helpers)
│   ├── services         (API client, external integrations)
│   ├── store            (Zustand stores)
│   ├── types            (TypeScript types & interfaces)
│   └── styles           (global CSS, Tailwind config)
├── public               (static assets)
└── next.config.js
```

### 6.2 State Management

**Server State (React Query):**

```tsx
// Fetch and cache bookings from API
const { data: bookings } = useQuery({
  queryKey: ['bookings'],
  queryFn: () => api.get('/bookings'),
});
```

**Local State (Zustand):**

```tsx
// UI state (modals, filters, etc.)
const useBookingStore = create((set) => ({
  filter: 'all',
  setFilter: (filter) => set({ filter }),
}));
```

### 6.3 Component Patterns

**Server Component (default):**

```tsx
// Fetches data on server, no JS shipped to browser
export default async function BookingList() {
  const bookings = await api.get('/bookings');
  return <div>{/* render */}</div>;
}
```

**Client Component:**

```tsx
'use client'; // Opt-in to client-side rendering

export function BookingForm() {
  const [formData, setFormData] = useState({});
  return <form>{/* interactive form */}</form>;
}
```

---

## 7. Platform Administration

### 7.1 Tenant Management

- Onboard new providers (verify business, create tenant)
- Monitor tenant usage (bookings, revenue)
- Suspend/terminate accounts
- View tenant analytics

### 7.2 User Moderation

- Flag suspicious user behavior
- Handle dispute escalations
- Moderate reviews and messages
- Ban users if needed

### 7.3 Feature Flags

- Release new features gradually (canary rollout)
- Kill-switch for broken features
- Permission-based feature gating

### 7.4 System Monitoring

- Application performance monitoring (APM)
- Error tracking and alerting
- Database performance metrics
- API request latency

---

## 8. Deployment & DevOps

### 8.1 Development Environment

```bash
# Start local services (Docker)
docker-compose up

# Run migrations
pnpm db:migrate

# Seed test data
pnpm db:seed

# Start backend
pnpm --filter @app/api start:dev

# Start frontend
pnpm --filter web dev
```

### 8.2 Production Deployment

- Frontend: Vercel or self-hosted Next.js
- Backend: Docker Compose on EC2
- Database: AWS RDS PostgreSQL
- Cache: AWS ElastiCache (Redis)
- Storage: AWS S3 (images, files)

### 8.3 CI/CD Pipeline

1. Code pushed to Git
2. Tests run (unit, integration, E2E)
3. Code review & approval required
4. Merge to main branch
5. Automated deployment to staging
6. Manual approval for production deploy
7. Health checks and smoke tests

---

## 9. Security Considerations

### 9.1 Multi-Tenant Isolation

- JWT includes tenant_id as immutable claim
- Middleware validates tenant context on every request
- Queries scoped to tenant_id (WHERE clause)
- Database RLS policies enforce at table level

### 9.2 Authentication Flow

1. User logs in with email/password or OAuth
2. Backend issues JWT (short-lived) + refresh token
3. Frontend stores JWT in memory, refresh token in httpOnly cookie
4. Subsequent requests include JWT in Authorization header
5. Middleware validates JWT signature and expiry
6. Refresh token used to get new JWT when expired

### 9.3 Payment Security

- No credit card data stored (Stripe handles tokenization)
- All payment API calls over HTTPS
- Stripe webhooks signed and verified
- PCI-DSS compliance via Stripe

### 9.4 Data Privacy

- GDPR right-to-deletion implemented
- Data export functionality
- Privacy policy and consent tracking
- User activity audit logs

---

## 10. Testing Strategy

### 10.1 Unit Tests

- Service layer logic
- Repository queries
- Utility functions
- Target: >80% coverage

### 10.2 Integration Tests

- API endpoint behavior
- Database operations
- External API integrations

### 10.3 E2E Tests

- User flows (booking, payment, review)
- Cross-browser compatibility
- Mobile responsiveness
- Performance benchmarks

---

## 11. Monitoring & Observability

### 11.1 Logging

- Structured JSON logs
- Log levels (error, warning, info, debug)
- Trace IDs for request tracking
- Sentry integration for error tracking

### 11.2 Metrics

- Application metrics (requests/sec, latency, errors)
- Business metrics (bookings/day, revenue, churn)
- Database metrics (query performance, connection pool)

### 11.3 Alerting

- Page on-call for critical errors
- Slack notifications for warnings
- Automated runbooks for common issues

---

## 12. Roadmap (High-Level)

| Phase | Timeline | Features                           |
| ----- | -------- | ---------------------------------- |
| MVP   | Q1 2024  | Core booking, auth, payments       |
| v1.1  | Q2 2024  | Multi-location, advanced reporting |
| v1.2  | Q3 2024  | Mobile app, PWA                    |
| v2.0  | Q4 2024  | Video consultations, marketplace   |

---

## Summary

This platform is a production-grade, multi-tenant SaaS application serving a dual-sided marketplace:

- **Backend:** NestJS + PostgreSQL + Redis
- **Frontend:** Next.js 14+ App Router
- **Real-Time:** WebSockets via Redis pub/sub
- **Payments:** Stripe integration
- **Multi-Tenancy:** Row-level security + tenant context in every query
- **Security:** JWT + refresh tokens + HTTPS + PCI-DSS compliance
- **Scalability:** Indexed queries, caching, job queues
- **Observability:** Structured logging, APM, error tracking

Development follows repository, service, and controller layer patterns with comprehensive test coverage and automated deployment pipelines.
