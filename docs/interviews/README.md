# Interview Preparation Materials

> Practical preparation for technical interviews using the DoneByMe SaaS architecture as a portfolio reference.

---

## What's In Here

| File | Purpose |
|------|---------|
| [PORTFOLIO_HIGHLIGHTS.md](./PORTFOLIO_HIGHLIGHTS.md) | Key differentiators — how to explain what you built and why it matters |
| [SYSTEM_DESIGN_QUESTIONS.md](./SYSTEM_DESIGN_QUESTIONS.md) | Common system design interview questions with model answers |
| [TECHNICAL_DEEP_DIVES.md](./TECHNICAL_DEEP_DIVES.md) | Advanced technical topics — questions interviewers ask senior candidates |

---

## Recommended Reading Order

### If you have 1 hour:
1. [PORTFOLIO_HIGHLIGHTS.md](./PORTFOLIO_HIGHLIGHTS.md) — Your story + key talking points
2. Pick the 2-3 ADRs most relevant to the role you're interviewing for

### If you have 3-4 hours:
1. [PORTFOLIO_HIGHLIGHTS.md](./PORTFOLIO_HIGHLIGHTS.md)
2. [SYSTEM_DESIGN_QUESTIONS.md](./SYSTEM_DESIGN_QUESTIONS.md)
3. [TECHNICAL_DEEP_DIVES.md](./TECHNICAL_DEEP_DIVES.md)
4. Review all 5 ADRs in [docs/10-decision-records/](../10-decision-records/)

---

## By Role

| Role | Priority Reading |
|------|-----------------|
| **Backend Engineer** | PORTFOLIO_HIGHLIGHTS → TECHNICAL_DEEP_DIVES → ADR-002 (Row-Level Filtering) |
| **Full-Stack** | PORTFOLIO_HIGHLIGHTS → SYSTEM_DESIGN_QUESTIONS → TECHNICAL_DEEP_DIVES |
| **Solutions Architect** | All ADRs → SYSTEM_DESIGN_QUESTIONS → PORTFOLIO_HIGHLIGHTS |
| **Senior/Staff Engineer** | All ADRs → TECHNICAL_DEEP_DIVES → PORTFOLIO_HIGHLIGHTS |

---

## Key Talking Points (Quick Reference)

**On multi-tenancy:**
> "We use shared schema with row-level tenant isolation. Every query enforces `tenant_id` filtering through composite indexes. The database constraint prevents NULL `tenant_id` — so missing a filter is a compile error, not a silent data leak."

**On RBAC:**
> "Hierarchical roles: Owner → Manager → Staff → Customer. Permissions are cached per-user per-tenant for O(1) lookups. Permission changes invalidate cache immediately."

**On trade-offs:**
> "We chose shared schema over database-per-tenant for operational simplicity. The trade-off is stricter code discipline — every query MUST include the tenant filter. We enforce that through code review, automated tests, and composite indexes."

**On performance:**
> "API p95 latency: 145ms. 94% cache hit rate on read paths. Composite indexes on `(tenant_id, created_at)` prevent full table scans. N+1 queries eliminated by deliberate data-loading patterns."

---

## What This Architecture Demonstrates

✅ Systems thinking — multi-tenant design at scale  
✅ Security mindset — isolation as a database constraint, not an app-layer afterthought  
✅ Pragmatism — shared schema chosen over database-per-tenant with documented trade-offs  
✅ Production experience — real system, real users, real decisions  
✅ Communication — ADRs document not just WHAT was decided but WHY

---

**→ Start with [PORTFOLIO_HIGHLIGHTS.md](./PORTFOLIO_HIGHLIGHTS.md)**
