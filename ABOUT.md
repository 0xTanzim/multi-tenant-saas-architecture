# About This Repository

## Who Built This

Hi, I'm **Tanzim** — a full-stack engineer focused on backend architecture, multi-tenant SaaS systems, and developer experience.

I built **DoneByMe** — a production salon booking platform — solo. It handles multi-tenant data isolation, real-time bookings, Stripe payments, loyalty programs, RBAC, PWA/mobile, and more.

This public repository contains the **architecture documentation and engineering decisions** from that system. I'm making it public so other engineers can learn from real production patterns, and to demonstrate my engineering thinking.

---

## Why This Repository Exists

DoneByMe is a private client project. The codebase can't be shared publicly.

But the **engineering decisions, architecture patterns, ADRs, and production learnings** can be.

This repo is proof-of-work: it shows how I think about systems, how I document decisions, and what it takes to build a production-grade multi-tenant SaaS platform from scratch — alone.

---

## What I Built in DoneByMe

| Feature | What It Involved |
|---------|-----------------|
| **Multi-Tenant Architecture** | Shared PostgreSQL schema with row-level security, composite indexes, tenant-scoped queries via Drizzle ORM |
| **Booking System** | Real-time availability, interval validation, conflict detection, lifecycle states (pending → confirmed → completed) |
| **Payments** | Stripe integration, platform fee split, connect accounts, webhook event handling |
| **RBAC** | Hierarchical role-based access control (Owner → Manager → Staff → Customer), tenant-scoped permissions |
| **Loyalty Program** | Points accumulation, redemption rules, fund management, expiry logic |
| **Search & Discovery** | Full-text PostgreSQL search, geolocation via PostGIS, filtering and ranking |
| **PWA & Mobile** | Service workers, offline support, Capacitor for Android/iOS builds |
| **Notifications** | Multi-channel notification system (push, in-app, email), queue-based delivery |
| **Analytics** | Materialized views for pre-aggregated dashboard metrics |
| **Deployment** | Docker, Nginx, AWS EC2, CI/CD pipeline, zero-downtime deployments |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Language** | TypeScript 5.x (strict mode) |
| **Backend** | NestJS with dependency injection |
| **Frontend** | Next.js 16 (App Router) |
| **Database** | PostgreSQL 15+ with Drizzle ORM |
| **Auth** | JWT + RBAC |
| **Cache** | Redis with tenant-scoped keys |
| **Mobile** | Capacitor (Android/iOS) |
| **Infra** | Docker, Nginx, AWS EC2 |
| **Monorepo** | pnpm Workspaces + Turborepo |

---

## How to Connect

If you're a hiring manager, engineer, or architect who wants to discuss this work:

| | |
|---|---|
| 🌐 **Website** | [0xtanzim.dev](https://0xtanzim.dev) |
| 👨‍💻 **GitHub** | [github.com/0xTanzim](https://github.com/0xTanzim) |
| 📧 **Email** | [tanzimhossain2@gmail.com](mailto:tanzimhossain2@gmail.com) |

Questions about specific architectural decisions? Open an issue or email directly.

---

## Repository Navigation

- **[README.md](./README.md)** — Overview and learning paths
- **[QUICKSTART.md](./QUICKSTART.md)** — Choose your entry point
- **[PORTFOLIO_INDEX.md](./PORTFOLIO_INDEX.md)** — Complete document index
- **[docs/interviews/](./docs/interviews/)** — Interview preparation materials
- **[docs/10-decision-records/](./docs/10-decision-records/)** — Architectural Decision Records (ADRs)

---

**This is real production work. Every pattern, decision, and trade-off came from building a system that handles real users and real money.**
