# System Diagrams — DoneByMe Architecture

> All key system diagrams in one place. Every diagram is also embedded in its relevant document section.

---

## 1. Full System Architecture

```mermaid
flowchart TB
    subgraph CLIENT["Client Layer"]
        WEB["Next.js 16\n(App Router)"]
        PWA["PWA / Service Worker"]
        MOB["Mobile\n(Capacitor iOS/Android)"]
    end

    subgraph GATEWAY["API Gateway — NestJS"]
        JWTG["JWT Guard\nVerifies token + extracts user"]
        TENANTG["Tenant Guard\nVerifies tenant ownership"]
        RBACG["RBAC Guard\nChecks role permissions"]
        RL["Rate Limiter\nPer-tenant quotas"]
    end

    subgraph SERVICES["Business Logic Layer — Services"]
        BS["BookingService"]
        PS["PaymentService"]
        LS["LoyaltyService"]
        SS["StaffService"]
        NS["NotificationService"]
        CS["CacheService (Redis)"]
    end

    subgraph REPOS["Data Access Layer — Repositories"]
        BR["BookingRepository"]
        PR["PaymentRepository"]
        LR["LoyaltyRepository"]
        NOTE["⚠️ tenant_id in EVERY query"]
    end

    subgraph INFRA["Infrastructure"]
        PG[("PostgreSQL 15+\nShared Schema\n18 Domains, 100+ Tables")]
        REDIS[("Redis\nTenant-scoped keys")]
        STRIPE["Stripe API\nPayments"]
        FCM["Firebase\nPush Notifications"]
        MAPS["Maps API\nGeolocation"]
    end

    CLIENT --> |HTTPS + JWT| GATEWAY
    GATEWAY --> SERVICES
    SERVICES --> REPOS
    SERVICES --> CS
    REPOS --> PG
    CS --> REDIS
    PS --> STRIPE
    NS --> FCM
    SS --> MAPS

    style NOTE fill:#fee2e2,stroke:#dc2626,color:#991b1b
    style PG fill:#f3e8ff,stroke:#a855f7
    style REDIS fill:#fef9c3,stroke:#ca8a04
```

---

## 2. Multi-Tenancy: Single-Tenant vs Multi-Tenant

```mermaid
flowchart LR
    subgraph OLD["❌ Single-Tenant (Per-Customer Deployment)"]
        direction TB
        S1["Salon A"] --> APP1["App"] --> DB1[("DB A")]
        S2["Salon B"] --> APP2["App"] --> DB2[("DB B")]
        S3["Salon C"] --> APP3["App"] --> DB3[("DB C")]
    end

    subgraph NEW["✅ Multi-Tenant (DoneByMe)"]
        direction TB
        T1["Salon A"]
        T2["Salon B"]
        T3["Salon C"]
        SAPP["Single App\n(NestJS)"]
        SDB[("Single PostgreSQL\ntenant_id on every row")]
        T1 & T2 & T3 --> SAPP --> SDB
    end

    style OLD fill:#fee2e2,stroke:#ef4444
    style NEW fill:#dcfce7,stroke:#22c55e
```

---

## 3. Tenant Isolation: The 3 Models

```mermaid
flowchart TD
    subgraph A["Model 1: Shared Schema — DoneByMe ✅"]
        A_APP["Application"] --> |"WHERE tenant_id = ?"| A_DB[("Shared DB\nAll tenants")]
    end

    subgraph B["Model 2: Database-Per-Tenant"]
        B_APP["Application"]
        B_APP --> B_DB1[("DB: Salon A")]
        B_APP --> B_DB2[("DB: Salon B")]
        B_APP --> B_DB3[("DB: Salon C")]
    end

    subgraph C["Model 3: Separate Infrastructure"]
        C1["Infra A\n(VPC + DB + App)"]
        C2["Infra B\n(VPC + DB + App)"]
        C3["Infra C\n(VPC + DB + App)"]
    end

    style A fill:#dcfce7,stroke:#16a34a
    style B fill:#fef9c3,stroke:#ca8a04
    style C fill:#fee2e2,stroke:#dc2626
```

**→ Full trade-off analysis:** [ADR-001](../10-decision-records/ADR-001-SHARED_SCHEMA_ISOLATION.md)

---

## 4. Tenant Context Flow (Request Lifecycle)

```mermaid
sequenceDiagram
    participant C as Client (Browser/App)
    participant J as JWT Guard
    participant T as Tenant Guard
    participant CTR as Controller
    participant SVC as Service
    participant REPO as Repository
    participant DB as PostgreSQL

    C->>J: POST /api/tenant/salon-abc/bookings<br/>Authorization: Bearer <JWT>
    J->>J: Decode JWT → { userId, activeTenantId, roles }
    J->>T: Pass decoded token
    T->>T: Verify route slug "salon-abc" matches activeTenantId
    T-->>CTR: req.user = { tenantId: "uuid-abc", userId, roles }

    CTR->>SVC: bookingService.create(dto, req.user.tenantId)
    Note over CTR: tenantId comes from JWT, never from client body

    SVC->>SVC: Validate business rules
    SVC->>REPO: bookingRepo.create(dto, tenantId)

    REPO->>DB: INSERT INTO bookings (tenant_id, ...) VALUES ('uuid-abc', ...)
    Note over REPO,DB: NOT NULL constraint on tenant_id<br/>Missing it fails at DB level

    DB-->>REPO: Booking row
    REPO-->>SVC: Booking entity
    SVC-->>CTR: BookingDto (tenantId stripped)
    CTR-->>C: 201 { id, startTime, status, customerId }
```

---

## 5. RBAC Role Hierarchy

```mermaid
flowchart TD
    PLATFORM_ADMIN["👑 Platform Admin\n(DoneByMe internal)\nFull system access"]

    TENANT_OWNER["🏢 Tenant Owner\n(Salon owner)\nFull tenant control"]

    TENANT_MANAGER["👔 Manager\nManage staff, services, reports"]

    STAFF["💇 Staff\nOwn schedule + assigned bookings"]

    CUSTOMER["👤 Customer\nBook services, view history"]

    PLATFORM_ADMIN -->|"can act as"| TENANT_OWNER
    TENANT_OWNER --> TENANT_MANAGER
    TENANT_MANAGER --> STAFF
    STAFF --> CUSTOMER

    WIDGET["🔗 Widget User\nEmbedded booking only\n(anonymous or authenticated)"]

    style PLATFORM_ADMIN fill:#f3e8ff,stroke:#a855f7
    style TENANT_OWNER fill:#dbeafe,stroke:#3b82f6
    style TENANT_MANAGER fill:#dcfce7,stroke:#22c55e
    style STAFF fill:#fef9c3,stroke:#ca8a04
    style CUSTOMER fill:#f1f5f9,stroke:#94a3b8
    style WIDGET fill:#fee2e2,stroke:#ef4444
```

**→ Full RBAC design:** [RBAC_ARCHITECTURE.md](../03-authorization-security/RBAC_ARCHITECTURE.md)

---

## 6. Booking State Machine

```mermaid
stateDiagram-v2
    [*] --> PENDING: Customer creates booking

    PENDING --> CONFIRMED: Staff/owner confirms
    PENDING --> CANCELLED: Customer cancels
    PENDING --> EXPIRED: No confirmation within window

    CONFIRMED --> IN_PROGRESS: Appointment time reached
    CONFIRMED --> CANCELLED: Customer/staff cancels
    CONFIRMED --> RESCHEDULED: Time changed

    RESCHEDULED --> CONFIRMED: New time confirmed
    RESCHEDULED --> CANCELLED: Customer cancels

    IN_PROGRESS --> COMPLETED: Service finished
    IN_PROGRESS --> NO_SHOW: Customer didn't appear

    COMPLETED --> [*]
    CANCELLED --> [*]
    EXPIRED --> [*]
    NO_SHOW --> [*]
```

**→ Full booking architecture:** [01-BOOKING_SYSTEM_ARCHITECTURE.md](../07-real-world-patterns/BOOKING/01-BOOKING_SYSTEM_ARCHITECTURE.md)

---

## 7. Payment Flow (Stripe Connect)

```mermaid
sequenceDiagram
    participant C as Customer
    participant APP as DoneByMe API
    participant STRIPE as Stripe
    participant SALON as Salon (Connect Account)

    C->>APP: POST /bookings/{id}/payment
    APP->>STRIPE: Create PaymentIntent<br/>amount: 100, currency: USD
    STRIPE-->>APP: { clientSecret, paymentIntentId }
    APP-->>C: { clientSecret }

    C->>STRIPE: Confirm payment (card details)
    STRIPE->>STRIPE: Charge customer card

    STRIPE->>APP: Webhook: payment_intent.succeeded
    APP->>APP: Record payment in DB (tenant scoped)
    APP->>STRIPE: Create Transfer<br/>to: salon_connect_account<br/>amount: 92 (after 8% platform fee)
    STRIPE-->>SALON: $92 transferred

    APP->>C: Booking confirmed + receipt
    APP->>APP: Update loyalty points
```

**→ Full payment architecture:** [01-PAYMENT_ARCHITECTURE.md](../07-real-world-patterns/PAYMENTS/01-PAYMENT_ARCHITECTURE.md)

---

## 8. Caching Strategy (Redis Tenant-Scoped Keys)

```mermaid
flowchart LR
    subgraph KEYS["Redis Key Pattern: tenant:{id}:{resource}:{id}"]
        K1["tenant:abc:schedule:staff-1\n→ TTL: 60s"]
        K2["tenant:abc:services:all\n→ TTL: 300s"]
        K3["tenant:abc:bookings:2026-05-16\n→ TTL: 30s"]
        K4["tenant:xyz:schedule:staff-5\n→ Completely separate"]
    end

    subgraph FLOW["Cache Read/Write Flow"]
        REQ["Request"] --> CHECK{"Cache hit?"}
        CHECK -->|"Yes"| RETURN["Return cached data\n(~1ms)"]
        CHECK -->|"No"| DB[("Query PostgreSQL\n(~30ms)")]
        DB --> STORE["Store in Redis\nwith tenant prefix"]
        STORE --> RETURN

        WRITE["Write/Update"] --> INVALIDATE["Invalidate only\nthat tenant's keys"]
    end

    style K4 fill:#fee2e2,stroke:#ef4444
    style STORE fill:#dcfce7,stroke:#22c55e
```

**→ Full caching design:** [CACHING_STRATEGY.md](../06-caching-performance/CACHING_STRATEGY.md)

---

## 9. Deployment Architecture

```mermaid
flowchart TB
    subgraph INTERNET["Internet"]
        USERS["Users\n(Browser / Mobile)"]
    end

    subgraph AWS["AWS EC2 / Production"]
        NGINX["Nginx\nReverse Proxy + SSL"]

        subgraph DOCKER["Docker Containers"]
            NEXT["Next.js\n:3001"]
            NEST["NestJS API\n:8444"]
        end

        subgraph DATA["Data Layer"]
            PG[("PostgreSQL 15\n:5432")]
            REDIS[("Redis\n:6379")]
        end
    end

    subgraph EXTERNAL["External Services"]
        STRIPE["Stripe"]
        FCM["Firebase FCM"]
        MAPS_API["Maps API"]
    end

    USERS --> NGINX
    NGINX --> NEXT
    NGINX --> NEST
    NEXT --> NEST
    NEST --> PG
    NEST --> REDIS
    NEST --> STRIPE
    NEST --> FCM
    NEST --> MAPS_API
```

**→ Full deployment guide:** [DEPLOYMENT_PROCEDURES.md](../08-deployment-operations/DEPLOYMENT_PROCEDURES.md)

---

## Navigation

| Diagram | Deep Dive Document |
|---------|-------------------|
| Full System Architecture | [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) |
| Multi-Tenancy Concepts | [MULTI_TENANT_FUNDAMENTALS.md](./MULTI_TENANT_FUNDAMENTALS.md) |
| Isolation Model Decision | [ADR-001](../10-decision-records/ADR-001-SHARED_SCHEMA_ISOLATION.md) |
| RBAC Role Hierarchy | [RBAC_ARCHITECTURE.md](../03-authorization-security/RBAC_ARCHITECTURE.md) |
| Booking State Machine | [01-BOOKING_SYSTEM_ARCHITECTURE.md](../07-real-world-patterns/BOOKING/01-BOOKING_SYSTEM_ARCHITECTURE.md) |
| Payment Flow | [01-PAYMENT_ARCHITECTURE.md](../07-real-world-patterns/PAYMENTS/01-PAYMENT_ARCHITECTURE.md) |
| Caching Strategy | [CACHING_STRATEGY.md](../06-caching-performance/CACHING_STRATEGY.md) |
| Deployment | [DEPLOYMENT_PROCEDURES.md](../08-deployment-operations/DEPLOYMENT_PROCEDURES.md) |
