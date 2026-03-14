> **Source**: Extracted from production system, sanitized for portfolio use
> **Original**: DoneByMe Capacitor Native Offline Implementation Plan
> **Status**: Proven Architecture

# Native Mobile Offline Implementation Plan

**Status:** Proven Architecture
**Depends on:** Capacitor framework fundamentals

---

## 1. Goal

Implement a native-capable mobile architecture that:

- starts without network
- preserves a strong PWA experience on the web
- supports local cached reads on native
- supports queued writes and sync recovery on native
- eliminates production dependence on remote asset loading

---

## 2. Final Architecture

### Web

```
Next.js App Router
+ Serwist Service Worker
+ browser PWA features
```

### Native Mobile

```
Capacitor
+ bundled local web assets
+ explicit API client calls
+ local persistence layer
+ sync queue for mutations
```

Native is not a wrapped remote website — it's a bundled application.

---

## 3. Scope Boundaries

### In Scope

- native startup architecture
- mobile-safe data access patterns
- local persistence strategy
- offline read behavior
- offline mutation queue behavior
- build and release profiles
- failure-state validation

### Out of Scope (First Implementation)

- full offline parity for every screen
- OTA update platform selection
- background sync beyond foreground reconnect
- cross-device merge resolution

---

## 4. Implementation Principles

1. Native app startup must render from bundled local assets
2. Mobile-critical screens must not depend on server-side rendering at runtime
3. Every offline-capable read model needs a local persistence owner
4. Every offline-capable mutation needs an explicit queue and reconciliation rule
5. Browser PWA caching and native offline persistence are separate systems

---

## 5. Workstreams

### Workstream A — Build Profiles

- `web` build profile for browser PWA
- `native` build profile for Capacitor local assets
- removal of production server asset loading
- documented dev-only remote loading path

### Workstream B — Mobile Data Access Layer

- mobile-safe API client boundary
- replacement strategy for server-action dependent flows
- request versioning where needed

### Workstream C — Local Persistence

- cache store for read models
- queue store for pending mutations
- sync metadata model

Storage guidance:

- Preferences: Capacitor Preferences API
- Domain cache: IndexedDB or SQLite
- Mutation queue: IndexedDB or SQLite
- Media queue: filesystem + metadata table

### Workstream D — Offline UX

- offline empty states
- stale-data indicators
- backend-unavailable state
- pending-sync indicators
- retry controls

### Workstream E — Validation Matrix

- test plan for network, auth, startup, update failure modes
- manual and automated validation checklist

---

## 6. Data Behavior Rules

### Reads

```
network first
→ cache success locally
→ fallback to local state on failure
```

### Writes

```
validate locally
→ enqueue
→ sync when online
→ mark success or failure explicitly
```

### Conflicts

Conflicts must not be hidden. Each queued mutation type needs one of:

- safe automatic retry
- last-write-wins policy
- explicit user resolution flow

---

## 7. Edge Cases That Must Pass

1. Cold start offline with no prior data: app shell renders and explains offline state
2. Cold start offline with prior data: cached content renders immediately
3. Warm start offline: last local state is visible
4. Internet available but backend down: app shell loads and shows backend unavailable state
5. Auth expired during offline period: protected writes stay queued with explicit status
6. Pending mutations after app kill/restart: queue remains intact
7. App storage cleared: app still boots from bundled assets
8. API contract drift after backend deploy: mobile fails safely instead of corrupting local data
9. Update incompatibility: new bundle can be rolled back or rejected cleanly

---

## 8. Screen Prioritization

### First Slice (Read-Heavy, Public)

1. Guest browsing shell
2. Resource search/discovery
3. Resource detail read model
4. Auth/session bootstrap shell

### Second Slice

1. User profile
2. Wallet/account information
3. Booking history read surfaces

### Third Slice

1. Queued write flows
2. Onboarding writes
3. Profile edits
4. Booking creation/edit flows

### Later Slices

1. Dashboard management flows
2. Business administration
3. Higher-risk financial operations

---

## 9. Delivery Sequence

### Phase 0

Approve architecture and freeze decision

### Phase 1

Separate browser PWA from native runtime in code and config

### Phase 2

Introduce native-safe shell and first read-only slice

### Phase 3

Introduce local cache and sync metadata

### Phase 4

Migrate first queued-write flows

### Phase 5

Create production native build profile with local bundle only

### Phase 6

Run full edge-case validation and stabilize

---

## 10. Release Decision

Do not ship the new native architecture until:

- no production dependence on remote asset loading
- no blank-screen startup path
- first-slice read models persist locally
- queued writes survive restarts
- offline, server-down, and auth-expired scenarios are validated

---

## 11. Key Differences from Web PWA

| Aspect           | Web PWA                       | Native Mobile              |
| ---------------- | ----------------------------- | -------------------------- |
| Asset Bundle     | Downloaded via service worker | Pre-bundled in app         |
| Update Mechanism | Service worker auto-update    | App Store update mechanism |
| Storage          | Browser cache + IndexedDB     | Native storage + IndexedDB |
| Network Recovery | Service worker fallback       | Queue-based reconciliation |
| App Icon         | Web manifest                  | Native app icon            |
| Permissions      | Browser permissions           | Native permission dialogs  |

---

## 12. Technology Stack

### New Packages

| Package                         | Purpose                        |
| ------------------------------- | ------------------------------ |
| `@capacitor/core`               | Native runtime bridge          |
| `@capacitor/cli`                | Build tooling for iOS/Android  |
| `@serwist/next`                 | Service worker for PWA caching |
| `@capacitor/push-notifications` | Native push support            |
| `@capacitor/camera`             | Native camera access           |
| `@capacitor/storage`            | Native storage API             |

### Development Tools

| Tool                          | Purpose                                |
| ----------------------------- | -------------------------------------- |
| Xcode                         | iOS builds                             |
| Android Studio                | Android builds                         |
| Apple Developer Account       | App Store distribution ($99/year)      |
| Google Play Developer Account | Play Store distribution ($25 one-time) |

---

## 13. Success Metrics

- Cold start time < 3 seconds (with cached data)
- App store approval on first submission
- Zero crashes on app resume from background
- Sync queue resilience > 99.9% (no data loss)
- Offline booking creation works end-to-end
- User activation rate > 40% (of web users)
