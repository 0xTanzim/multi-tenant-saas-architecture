# Multi-Tenant SaaS Architecture Reference

> **Built by [Tanzim](https://0xtanzim.dev)** — A production-grade reference implementation showcasing complete strategies for building scalable, secure, and isolated SaaS platforms.

Built as **DoneByMe** — a real-world salon booking platform I built solo — this repository documents the architectural decisions, patterns, and engineering trade-offs from a production multi-tenant system.

**[0xtanzim.dev](https://0xtanzim.dev)** &nbsp;·&nbsp; **[GitHub @0xTanzim](https://github.com/0xTanzim)** &nbsp;·&nbsp; **[tanzimhossain2@gmail.com](mailto:tanzimhossain2@gmail.com)**

→ **[ABOUT.md](./ABOUT.md)** — Full project background and author profile

---

## 🎯 What This Is

A **complete reference for engineers, architects, and technical leaders** building SaaS systems.

**This repository answers:**

- How do you build true tenant isolation without separate databases?
- What does a production SaaS API actually look like?
- How do you scale multi-tenant systems without compromising security?
- What architectural decisions matter most — and what are the trade-offs?
- How do you prevent data leaks across tenants at the database level?

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                             │
│            Next.js 16 (App Router) · PWA · Mobile              │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTPS / JWT
┌───────────────────────────▼─────────────────────────────────────┐
│                      API GATEWAY                                │
│              NestJS · Guards · Rate Limiting                    │
│                                                                 │
│   ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│   │  Tenant      │  │    Auth      │  │   Permission      │   │
│   │  Guard       │  │    Guard     │  │   Guard (RBAC)    │   │
│   └──────┬───────┘  └──────┬───────┘  └─────────┬─────────┘   │
└──────────┼────────────────┼──────────────────────┼─────────────┘
           │                │                      │
┌──────────▼────────────────▼──────────────────────▼─────────────┐
│                    BUSINESS LOGIC LAYER                         │
│    BookingService · PaymentService · LoyaltyService · ...      │
└───────────────────────────┬─────────────────────────────────────┘
                            │ tenant_id flows through every call
┌───────────────────────────▼─────────────────────────────────────┐
│                    DATA ACCESS LAYER                            │
│    Repositories · Drizzle ORM · tenant_id on EVERY query        │
└──────────┬────────────────────────────────────────┬────────────┘
           │                                        │
┌──────────▼──────────┐                   ┌────────▼────────────┐
│    PostgreSQL 15+   │                   │        Redis        │
│  Shared Schema +    │                   │   Tenant-Scoped     │
│  Row-Level Security │                   │   Cache Keys        │
└─────────────────────┘                   └─────────────────────┘
```

**Core isolation principle:** `tenant_id` is a NOT NULL column on every table, present in every query, enforced by composite indexes and database constraints — not just application logic.

> 📊 **[View all 9 system diagrams →](./docs/01-core-concepts/SYSTEM_DIAGRAMS.md)** — Request lifecycle, RBAC hierarchy, booking state machine, payment flow, caching strategy, deployment architecture

---

## 📚 What's Included

**80+ documents** across 14 sections:

| Section | Description |
| ------- | ----------- |
| **Core Concepts** | Multi-tenancy fundamentals, isolation strategies, data modeling |
| **Tenant Management** | Tenant architecture, data model, widget integration |
| **Security & Auth** | JWT auth, RBAC system, multi-tenant isolation, security best practices |
| **Database Design** | Schema patterns, Drizzle query examples, migration strategy, soft deletes |
| **API Design** | REST patterns, tenant context propagation, rate limiting, versioning |
| **Caching & Performance** | Redis patterns, tenant-aware caching, performance optimization |
| **Real-World Patterns** | 12 business domains: booking, payments, loyalty, search, geolocation, PWA, notifications, and more |
| **Deployment & Operations** | Docker, Kubernetes, CI/CD, monitoring, disaster recovery |
| **Testing & Quality** | Strategy, tenant isolation tests, performance testing, data seeding |
| **Decision Records** | 5 ADRs — major choices with context, options evaluated, and trade-offs |
| **FAQ & Troubleshooting** | Common questions, feature flags, subscription model |
| **Proposals & RFCs** | 5 feature investigations with pros/cons analysis |
| **Design System** | Color palette, UI/UX flows |
| **Audit & Compliance** | Platform fee audit report |
| **Interview Prep** | Portfolio highlights, system design questions, technical deep dives |

---

## 🚀 Tech Stack

- **Language**: TypeScript 5.x (strict mode)
- **Backend**: NestJS with dependency injection
- **Frontend**: Next.js 16 (App Router)
- **Database**: PostgreSQL 15+ with Drizzle ORM
- **Authentication**: JWT + Role-Based Access Control (RBAC)
- **Caching**: Redis with tenant-scoped keys
- **Containerization**: Docker & Docker Compose
- **Package Management**: pnpm Monorepo with Turborepo
- **Mobile**: Capacitor (Android/iOS)

---

## 🎓 Where to Start

**→ [QUICKSTART.md](./QUICKSTART.md)** — Choose your learning path

| Role | Suggested Path |
| ---- | -------------- |
| **Architect / System Designer** | [Core Concepts](./docs/01-core-concepts/) → [Tenant Management](./docs/02-tenant-management/) → [Decision Records](./docs/10-decision-records/) |
| **Backend Engineer** | [Core Concepts](./docs/01-core-concepts/) → [Auth & Security](./docs/03-authorization-security/) → [Database Design](./docs/04-database-design/) → [API Design](./docs/05-api-design/) |
| **Interview Candidate** | [Portfolio Highlights](./docs/interviews/PORTFOLIO_HIGHLIGHTS.md) → [System Design Questions](./docs/interviews/SYSTEM_DESIGN_QUESTIONS.md) → [Technical Deep Dives](./docs/interviews/TECHNICAL_DEEP_DIVES.md) |
| **DevOps / Platform** | [Deployment & Operations](./docs/08-deployment-operations/) → [Testing & Quality](./docs/09-testing-quality/) → [Caching & Performance](./docs/06-caching-performance/) |

---

## 🔐 Architecture Highlights

### Tenant Isolation Strategy

- Shared PostgreSQL schema — single database, all tenants in shared tables
- `tenant_id` NOT NULL on every table — enforced at database level, not just app logic
- Composite indexes: `(tenant_id, field)` on all frequently-queried columns
- Composite foreign keys: `FOREIGN KEY (tenant_id, staff_id)` prevent cross-tenant references
- Soft deletes with tenant-scoped cleanup and audit compliance
- JWT carries tenant claim — extracted by guard, flows through every service call

### Scalability

- Stateless NestJS backend — horizontally scalable
- Read replicas for scaling read-heavy queries
- Redis cache layer with tenant-prefixed keys (`tenant:{id}:resource:{id}`)
- Cursor-based pagination for large result sets
- Connection pooling and query optimization

### Security & Compliance

- JWT authentication with tenant claim embedded
- Hierarchical RBAC: Owner → Manager → Staff → Customer
- SQL injection prevention via Drizzle ORM parameterized queries
- Comprehensive audit logging with tenant context
- Rate limiting per tenant with configurable quotas
- GDPR compliance: soft deletes, data retention policies

---

## 📊 Production Metrics (from DoneByMe system)

These numbers are from the actual DoneByMe production deployment:

| Metric | Target | Achieved |
| ------ | ------ | -------- |
| **API Latency (p95)** | <200ms | 145ms |
| **Database Query Time (median)** | <50ms | 32ms |
| **Tenant Isolation** | 100% enforced | ✅ 100% |
| **System Uptime** | 99.9% | 99.95% |
| **Cache Hit Rate** | >90% | 94% |

---

## 📖 Documentation Structure

```
multi-tenant-saas-architecture/
├── ABOUT.md                           # Who built this + project background
├── README.md                          # This file
├── QUICKSTART.md                      # Learning paths by role
├── PORTFOLIO_INDEX.md                 # Complete document index (80+ files)
├── CONTRIBUTING.md                    # How to contribute
├── LICENSE                            # MIT
└── docs/
    ├── 00-requirements/               # Client specs, developer setup
    ├── 01-core-concepts/              # Architecture, multi-tenancy fundamentals
    ├── 02-tenant-management/          # Tenant architecture, widgets
    ├── 03-authorization-security/     # Auth, RBAC, isolation, security
    ├── 04-database-design/            # Schema patterns, queries, migrations
    ├── 05-api-design/                 # REST patterns, versioning, webhooks
    ├── 06-caching-performance/        # Caching, optimization, monitoring
    ├── 07-real-world-patterns/        # 12 business domains
    │   ├── BOOKING/
    │   ├── PAYMENTS/
    │   ├── LOYALTY/
    │   ├── ANALYTICS/ (under CALENDAR/)
    │   ├── STAFF/
    │   ├── SEARCH/
    │   ├── GEOLOCATION/
    │   ├── TIME_OFF/
    │   ├── MOBILE_AND_OFFLINE/
    │   ├── NOTIFICATIONS/
    │   ├── SECURITY_AND_PERFORMANCE/
    │   └── CROSS_DOMAIN/
    ├── 08-deployment-operations/      # Docker, Kubernetes, CI/CD, monitoring
    ├── 09-testing-quality/            # Testing strategy, isolation, seeding
    ├── 10-decision-records/           # 5 ADRs with trade-off analysis
    ├── 11-faq-troubleshooting/        # FAQs and troubleshooting
    ├── 12-proposals-rfcs/             # 5 feature investigations
    ├── 13-design-system/              # Colors, UI/UX flows
    ├── 14-audit-compliance/           # Fee audit, compliance
    └── interviews/                    # Interview preparation materials
```

---

## 💡 Key Takeaways

1. **Tenant isolation is the top priority** — every architectural decision flows from this constraint
2. **Composite indexes prevent contamination** — `(tenant_id, field)` enforces tenant boundaries at query time
3. **Row-level filtering at the database layer** — not UI tricks, not caching workarounds
4. **Composite foreign keys close the cross-tenant reference gap** — app-layer filtering alone isn't enough
5. **Type safety saves debugging hours** — TypeScript + Zod catch errors at compile time
6. **Audit everything** — structured logs with tenant context make debugging and compliance tractable
7. **Monorepo = shared vocabulary** — teams stay aligned on patterns and types

---

## 🤝 Contributing

This is a reference repository and portfolio showcase. If you'd like to suggest improvements or report issues, see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## 📝 License

MIT — See [LICENSE](./LICENSE) for details.

---

## 📧 Next Steps

1. **[ABOUT.md](./ABOUT.md)** — Who built this and the project background
2. **[QUICKSTART.md](./QUICKSTART.md)** — Choose your learning path (Architect / Engineer / Interviewer / Code)
3. **[PORTFOLIO_INDEX.md](./PORTFOLIO_INDEX.md)** — Full document index with navigation by role and domain
4. **[docs/10-decision-records/](./docs/10-decision-records/)** — Start with ADR-001 for the foundational choice

---

**Built from a real production system. Every pattern, decision, and trade-off came from building DoneByMe — a multi-tenant salon booking platform — solo.**
