# Employment-Based Staff Model

> **Source**: Production system
> **Architecture**: 3-layer global identity model

## The Problem

Staff need to work at multiple salons with different roles, pay, and visibility at each. A stylist who works at two salons might be a manager at one and a regular staff member at the other. Duplicating staff profiles per salon is wrong. Using the same role and permissions everywhere is also wrong.

## The Solution: LinkedIn-Style 3-Layer Model

### Layer 1: Global Staff Profile

One profile per person, shared across all salons. Contains:
- Identity: display name, bio, profile image
- Credentials: certifications, languages, specializations
- Portfolio: images, social links
- Privacy settings: show/hide contact info

### Layer 2: Per-Salon Employment

One record per staff member per salon. Each employment has independent:
- **Role**: owner, manager, or staff
- **Status**: hired, active, inactive, suspended, on_leave, terminated
- **Permissions**: manage bookings, manage staff, view analytics (different per salon)
- **Financial**: hourly rate, commission rate, deposit percentage
- **Visibility**: shown/hidden from customers per salon
- **Booking rules**: auto-approve, max bookings per day, min notice hours

### Layer 3: Per-Service Competencies

Links an employment to specific services with:
- Custom price override
- Custom duration override
- Proficiency level (beginner, standard, expert, master)
- Performance tracking (total bookings, revenue, rating per service)

### How They Connect

```
User → Staff Profile → Staff Employment (×N salons) → Staff Services (×N services)
```

Sarah can be manager at Salon A (can manage staff, view analytics) and staff at Salon B (can only manage own schedule). Each salon sees different permissions, pay rates, and visibility settings.

## Onboarding: 3 User Scenarios

When a salon owner invites someone, the system detects which scenario applies:

| Scenario | Condition | What Gets Created |
|----------|-----------|------------------|
| New user | No account, no employments | User + profile + employment |
| Existing customer | Has account, not staff elsewhere | Just employment (reuse profile) |
| Multi-salon staff | Has account, works elsewhere | Just employment (reuse profile + identity) |

A dedicated detection service (`StaffUserDetectionService`) identifies the scenario before onboarding begins, enabling form pre-filling and correct routing.
