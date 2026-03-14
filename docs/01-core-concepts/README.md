# Core Concepts & Fundamentals

Foundation-level architecture and principles for multi-tenant SaaS systems. Start here before diving into any other section.

---

## 📄 Documents in This Section

### 0. [SYSTEM_DIAGRAMS.md](./SYSTEM_DIAGRAMS.md) ⭐ START WITH VISUALS
**9 Mermaid diagrams covering the entire system — see before reading anything else.**

- Full system architecture (all layers + external services)
- Multi-tenancy concept diagram
- All 3 isolation models compared
- Tenant context request flow (sequence diagram)
- RBAC role hierarchy
- Booking state machine
- Payment flow with Stripe
- Redis caching key strategy
- Deployment architecture

### 1. [MULTI_TENANT_FUNDAMENTALS.md](./MULTI_TENANT_FUNDAMENTALS.md)
**Start here if you're new to multi-tenancy.**

- What is multi-tenancy and why it matters for SaaS
- The three isolation models: Shared Schema vs Separate DB vs Separate Infrastructure
- Trade-off comparison with real-world examples (Stripe, Figma, Notion)
- The critical security requirements for shared schema
- Implementation checklist

### 2. [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md)
**The 4-layer system design of DoneByMe.**

- Presentation → Business Logic → Data Access → Infrastructure layers
- Controller / Service / Repository responsibilities
- Complete request flow: HTTP → Guard → Controller → Service → Repository → DB → Response
- Caching strategy and error handling patterns
- Layer interaction rules and why they prevent security bugs

### 3. [KEY_PRINCIPLES.md](./KEY_PRINCIPLES.md)
**The engineering philosophy behind every decision.**

- Immutable design constraints (what we never compromise)
- Separation of concerns in practice
- Single responsibility at each layer
- Scalability patterns from the start
- Performance considerations built into the architecture

---

## 🗺️ Reading Order

**New to multi-tenancy?**
1. `MULTI_TENANT_FUNDAMENTALS.md` — Understand the concepts first
2. `ARCHITECTURE_OVERVIEW.md` — See how it maps to the actual system
3. `KEY_PRINCIPLES.md` — Understand the engineering philosophy

**System designers?**
1. `ARCHITECTURE_OVERVIEW.md` — Start with the system design
2. `KEY_PRINCIPLES.md` — Understand constraints
3. Then go to `../02-tenant-management/` for implementation details

**Database architects?**
1. `MULTI_TENANT_FUNDAMENTALS.md` — Isolation model trade-offs
2. Then go to `../04-database-design/SCHEMA_DESIGN_PATTERNS.md` for schema implementation

---

## 🔑 Key Concepts

| Term | Definition |
|------|-----------|
| **Tenant** | An independent customer/organization (a salon in DoneByMe) |
| **Tenant ID** | UUID uniquely identifying a tenant — present on every row, in every query |
| **Tenant Context** | Runtime state extracted from JWT: which tenant is this request for? |
| **Row-Level Isolation** | Application-layer `WHERE tenant_id = ?` filtering on every database query |
| **Tenant Escape** | Security vulnerability where a query returns data from another tenant |
| **Composite Index** | `(tenant_id, other_field)` index — ensures tenant queries never scan other tenants' data |

---

## 🔗 Where to Go Next

After reading the core concepts:

- **Tenant Architecture** → `../02-tenant-management/` — How tenants are structured, data model
- **Security & Auth** → `../03-authorization-security/` — JWT, RBAC, isolation enforcement
- **Database Design** → `../04-database-design/` — Schema patterns, queries, migration strategy
- **Decision Records** → `../10-decision-records/` — Why shared schema was chosen over alternatives
