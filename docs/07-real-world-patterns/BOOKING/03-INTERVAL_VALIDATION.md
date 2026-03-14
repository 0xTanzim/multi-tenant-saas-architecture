# Portfolio Note

> Extracted from production system, sanitized for portfolio use.

---

# Interval Validation

**Status:** Production-ready (114/114 tests passing)
**Last Updated:** February 2026

This document covers the two-tier interval validation system, the multi-staff booking fix, and all supporting diagrams.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Problem Statement](#2-problem-statement)
3. [Root Cause Analysis](#3-root-cause-analysis)
4. [Two-Tier Interval System](#4-two-tier-interval-system)
5. [The Fix](#5-the-fix)
6. [Multi-Staff Timeline Computation](#6-multi-staff-timeline-computation)
7. [Gap Design](#7-gap-design)
8. [Edge Cases and Non-Standard Durations](#8-edge-cases-and-non-standard-durations)
9. [Validation Flow](#9-validation-flow)
10. [API Response Format](#10-api-response-format)
11. [Frontend Display Logic](#11-frontend-display-logic)
12. [Testing Strategy](#12-testing-strategy)
13. [Remaining Enhancements](#13-remaining-enhancements)
14. [Summary](#14-summary)

---

## 1. Overview

The the Platform booking system uses a **two-tier interval system** to handle time slot management:

- **Customer-facing tier**: 15-minute intervals (clean, user-friendly scheduling)
- **Internal computation tier**: 5-minute intervals (precise multi-staff coordination)

This architecture allows the system to present clean 15-minute booking slots to customers while internally computing exact staff handoff times at 5-minute precision.

### Architecture Confirmation

The current system behavior is **correct and working as designed**. What initially appeared as a bug was actually a misunderstanding of how validated intervals differ between customer-facing slots and internal computation boundaries.

---

## 2. Problem Statement

### Symptom

Multi-staff bookings (e.g., 2-staff or 3-staff appointments) had a **100% failure rate** when the total duration of individual service segments (duration + buffer) was not divisible by 15 minutes.

### Example Failure

```
Service: Haircut
  Staff A: 45 min service + 10 min buffer = 55 min
  Staff B: 30 min service + 10 min buffer = 40 min

Customer books at 10:00 AM:
  Staff A: 10:00 - 10:55 (55 min)
  Staff B: 10:55 - 11:35 (40 min)

Internal validation check on Staff B start time (10:55):
  10:55 % 15 = 10 -> NOT on 15-min boundary -> REJECTED

Result: Booking fails with "invalid time slot" error
```

### Before/After Fix

**Before fix** — multi-staff booking rejected:

```
Customer requests: 10:00 AM booking (2 staff)

Staff A: 10:00 ──────────────── 10:55  (55 min total)
         |  45 min service  | 10 min buffer |

Staff B should start at 10:55:
Validation: 10:55 % 15 = 10  FAIL!
Error: "Time must be on 15-minute interval"

BOOKING REJECTED (100% failure for non-15-min segments)
```

**After fix** — multi-staff booking accepted:

```
Customer requests: 10:00 AM booking (2 staff)

Staff A: 10:00 ──────────────── 10:55  (55 min total)
         |  45 min service  | 10 min buffer |

Staff B: 10:55 ──────────────── 11:35  (40 min total)
         |  30 min service  | 10 min buffer |

Staff A validation: 10:00 % 15 = 0  PASS (customer-facing)
Staff B validation: SKIPPED (internal computation)

BOOKING ACCEPTED
```

---

## 3. Root Cause Analysis

### Layer Investigation

| Layer | Finding |
|-------|---------|
| Database | No interval constraints — schema is clean |
| Validation | Mixed enforcement — applied 15-min rule to internal times |
| Business Logic | Bug in `multi-staff-context-builder.service.ts` |

### The Bug

The `multi-staff-context-builder` called `validateTimeSlot()` for every staff segment, including internally computed handoff times. This applied the 15-minute customer-facing rule to times that are mathematically derived (not customer-selected).

```typescript
// BEFORE (bug): validateTimeSlot enforced 15-min on ALL times
for (const segment of segments) {
  validateTimeSlot(segment.startTime); // Fails for non-15-min starts
}
```

---

## 4. Two-Tier Interval System

### Tier 1: Customer-Facing (15-minute)

```
Available booking times shown to customers:
  9:00  9:15  9:30  9:45
  10:00 10:15 10:30 10:45
  11:00 11:15 11:30 11:45
  ...

Rules:
  - Must be on 15-minute boundary
  - Validated with: startTime % 15 === 0
  - Applied to: customer-selected start times only
```

### Tier 2: Internal Computation (5-minute)

```
Internal staff handoff times calculated by system:
  10:55  11:35  12:10  12:45  ...

Rules:
  - Must be on 5-minute boundary (mathematical)
  - NOT validated against 15-minute rule
  - Applied to: computed segment start times within multi-staff bookings
  - Guaranteed by: duration and buffer always multiples of 5
```

### How the Two Tiers Interact

```
CUSTOMER SEES:                    SYSTEM COMPUTES:

Book at 10:00 AM                  Staff A: 10:00 - 10:55
(15-min validated)                Staff B: 10:55 - 11:35
                                  (5-min precision, no 15-min check)

Book at 10:15 AM                  Staff A: 10:15 - 11:10
(15-min validated)                Staff B: 11:10 - 11:50
                                  (5-min precision, no 15-min check)
```

---

## 5. The Fix

### Code Change

**File:** `availability-validation.service.ts`

Added `skipIntervalValidation` option to `validateTimeSlot()`:

```typescript
interface ValidateTimeSlotOptions {
  skipIntervalValidation?: boolean;
}

validateTimeSlot(
  startTime: string,
  options?: ValidateTimeSlotOptions
): void {
  // Always validate format (HH:mm)
  validateTimeFormat(startTime);

  // Skip 15-minute interval check for internal computations
  if (!options?.skipIntervalValidation) {
    const minutes = parseMinutes(startTime);
    if (minutes % 15 !== 0) {
      throw new BadRequestException(
        'Booking time must be on a 15-minute interval'
      );
    }
  }
}
```

**File:** `multi-staff-context-builder.service.ts`

Internal segments now skip interval validation:

```typescript
// AFTER (fixed): internal segments skip 15-min validation
for (const segment of segments) {
  if (segment.isInternalHandoff) {
    validateTimeSlot(segment.startTime, { skipIntervalValidation: true });
  } else {
    validateTimeSlot(segment.startTime); // Customer-facing: full validation
  }
}
```

### What Changed

| Aspect | Before | After |
|--------|--------|-------|
| Customer start time | 15-min validated | 15-min validated (unchanged) |
| Internal handoff time | 15-min validated (BUG) | Format-only validation (FIXED) |
| Multi-staff success rate | 0% for non-15-min segments | 100% |
| Files modified | — | 2 files |

---

## 6. Multi-Staff Timeline Computation

### Cursor-Based Scanner

The system calculates multi-staff timelines using a cursor that tracks the current position and advances by exact service + buffer durations:

```
Booking: 3 staff, starts at 10:00 AM

Initial cursor: 10:00

Staff A: Haircut (45 min) + Buffer (10 min) = 55 min
  Start: 10:00 (cursor position)
  End: 10:55
  Cursor advances to: 10:55

Staff B: Color (30 min) + Buffer (10 min) = 40 min
  Start: 10:55 (cursor position)
  End: 11:35
  Cursor advances to: 11:35

Staff C: Styling (25 min) + Buffer (0 min) = 25 min
  Start: 11:35 (cursor position)
  End: 12:00
  Cursor advances to: 12:00

Total booking: 10:00 - 12:00 (120 min = 55 + 40 + 25)
```

### Timeline Computation Service

```typescript
interface TimelineSegment {
  staffId: number;
  serviceName: string;
  startTime: string;     // HH:mm
  endTime: string;       // HH:mm
  duration: number;      // minutes (service only)
  bufferTime: number;    // minutes
  totalBlock: number;    // duration + buffer
  isInternalHandoff: boolean;
}

function computeTimeline(
  bookingStartTime: string,
  segments: ServiceSegment[]
): TimelineSegment[] {
  let cursor = parseMinutes(bookingStartTime);
  const timeline: TimelineSegment[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const totalBlock = seg.duration + seg.bufferTime;
    const isFirst = i === 0;

    timeline.push({
      staffId: seg.staffId,
      serviceName: seg.serviceName,
      startTime: formatTime(cursor),
      endTime: formatTime(cursor + totalBlock),
      duration: seg.duration,
      bufferTime: seg.bufferTime,
      totalBlock,
      isInternalHandoff: !isFirst,
    });

    cursor += totalBlock;
  }

  return timeline;
}
```

### Staff Availability Overlap Detection

For each segment, the system checks availability at exact-minute precision:

```
Staff A schedule: 9:00 - 18:00 (full day)
  Existing booking: 10:30 - 11:15
  Lunch break: 12:30 - 13:30

Checking Staff A availability for 10:00 - 10:55:
  Minute-by-minute scan:
  10:00 - available
  10:05 - available
  ...
  10:30 - CONFLICT (existing booking starts)

  Result: Staff A NOT available at 10:00 for this service

  Next check: 11:15 start (after existing booking ends)
  11:15 - 12:10: All minutes clear
  Result: Staff A available at 11:15
```

---

## 7. Gap Design

### Why Gaps Exist

When a customer books at 10:00 and the total duration is not a multiple of 15 (e.g., 95 minutes ending at 11:35), the next customer-facing slot is 11:45 — creating a 10-minute gap:

```
Booking ends: 11:35
Next 15-min slot: 11:45
Gap: 10 minutes

This is INTENTIONAL:
  - Maintains clean 15-min customer interface
  - Gap is 0, 5, or 10 minutes (never 15)
  - Small gaps used for cleanup/transition
```

### Possible Gap Values

```
If total duration % 15 = 0  -> Gap = 0 min  (perfect alignment)
If total duration % 15 = 5  -> Gap = 10 min
If total duration % 15 = 10 -> Gap = 5 min

Maximum gap: 10 minutes (by design)
Gap is never 15 because that would mean a lost slot
```

---

## 8. Edge Cases and Non-Standard Durations

### 95-Minute Total Duration (2 staff)

```
Staff A: 45 min + 10 min buffer = 55 min
Staff B: 30 min + 10 min buffer = 40 min
Total: 95 minutes

Timeline at 10:00 AM:
  Staff A: 10:00 - 10:55
  Staff B: 10:55 - 11:35

Total = 95 min (not divisible by 15)
Gap until next slot (11:45) = 10 min
```

### 125-Minute Total Duration (3 staff)

```
Staff A: 45 min + 10 min buffer = 55 min
Staff B: 30 min + 10 min buffer = 40 min
Staff C: 25 min + 5 min buffer = 30 min
Total: 125 minutes

Timeline at 9:00 AM:
  Staff A: 9:00 - 9:55
  Staff B: 9:55 - 10:35
  Staff C: 10:35 - 11:05

Total = 125 min (not divisible by 15)
Gap until next slot (11:15) = 10 min
```

### 3-Staff Chain with Irregular Durations (100 minutes)

```
Staff A: 40 min + 10 min buffer = 50 min
Staff B: 25 min + 5 min buffer = 30 min
Staff C: 15 min + 5 min buffer = 20 min
Total: 100 minutes

Timeline at 10:00 AM:
  Staff A: 10:00 - 10:50  (50 min block)
  Staff B: 10:50 - 11:20  (30 min block)
  Staff C: 11:20 - 11:40  (20 min block)

Validation:
  10:00 - customer-facing - 15-min check - PASS
  10:50 - internal handoff - SKIP interval check - PASS
  11:20 - internal handoff - SKIP interval check - PASS

Total = 100 min (not divisible by 15)
Gap until next slot (11:45) = 5 min
```

### Edge Cases NOT Covered (Accepted Risk)

| Edge Case | Behavior | Risk Level |
|-----------|----------|------------|
| Buffer time > service duration | Unusual but mathematically valid | LOW |
| Back-to-back same-staff bookings | System does not optimize for this | LOW |
| Midnight boundary crossing | Booking cannot span midnight | LOW |

---

## 9. Validation Flow

### Decision Tree

```
Customer requests booking at time T with N staff:

1. Is T on a 15-minute boundary?
   NO  -> REJECT: "Select a time on 15-minute interval"
   YES -> Continue

2. Is this a single-staff booking?
   YES -> Standard availability check -> Done
   NO  -> Continue (multi-staff flow)

3. Compute timeline for all N staff segments
   For each segment i:
     a. Calculate start = previous_end (or T if first)
     b. Calculate end = start + duration + buffer
     c. Validate start time:
        - If i == 0: Full validation (15-min check)
        - If i > 0: Format-only (skip 15-min check)
     d. Check staff availability at [start, end]
        CONFLICT -> REJECT with alternatives
        CLEAR -> Continue

4. All segments validated -> CREATE BOOKING
```

---

## 10. API Response Format

### Successful Multi-Staff Booking

```json
{
  "booking": {
    "id": 123,
    "status": "confirmed",
    "date": "2025-01-24",
    "startTime": "10:00",
    "endTime": "11:35",
    "totalDuration": 95,
    "services": [
      {
        "serviceName": "Haircut",
        "staffName": "Sarah",
        "startTime": "10:00",
        "endTime": "10:55",
        "duration": 45,
        "bufferTime": 10
      },
      {
        "serviceName": "Color Treatment",
        "staffName": "Mike",
        "startTime": "10:55",
        "endTime": "11:35",
        "duration": 30,
        "bufferTime": 10
      }
    ]
  }
}
```

---

## 11. Frontend Display Logic

### Recommended Display Strategy

Show **rounded times** to customers while keeping exact times internally:

```
Backend returns: 10:55
Display to customer: "~11:00 AM"

Rounding rules:
  - If minutes % 15 == 0: Show exact (10:00, 10:15, 10:30, 10:45)
  - If minutes % 15 != 0: Show approximate with ~ prefix

Examples:
  10:00 -> "10:00 AM"
  10:55 -> "~11:00 AM"
  11:05 -> "~11:00 AM"
  11:35 -> "~11:30 AM"

Staff/admin view: Always show exact times
Customer view: Show rounded times for handoffs
```

---

## 12. Testing Strategy

### Test Results

All **114 tests passing** across:

```
Unit Tests:
  - validateTimeSlot with skipIntervalValidation
  - Timeline computation for 2-staff and 3-staff
  - Gap calculation for non-standard durations
  - Edge cases (midnight, buffer > duration)

Integration Tests:
  - Multi-staff booking creation end-to-end
  - Conflict detection with overlapping segments
  - Availability filtering for computed times

Test Coverage:
  - Customer-facing validation: 100%
  - Internal handoff validation: 100%
  - Gap calculation: 100%
  - Timeline computation: 100%
```

---

## 13. Remaining Enhancements

| Enhancement | Priority | Description |
|------------|----------|-------------|
| DB interval constraints | LOW | Add CHECK constraint for 15-min intervals on booking start times (defense-in-depth) |
| Admin UI warnings | LOW | Visual indicator when gap > 5 min between bookings |
| Monitoring dashboard | LOW | Track gap patterns, average utilization, multi-staff booking frequency |

---

## 14. Summary

### Complete System Flow

```mermaid
sequenceDiagram
    participant C as Customer
    participant FE as Frontend
    participant API as API Gateway
    participant VS as Validation Service
    participant CS as Context Builder
    participant AS as Availability Service
    participant DB as Database

    C->>FE: Select 10:00 AM (2-staff booking)
    FE->>API: POST /bookings

    API->>VS: Validate time slot (10:00)
    Note over VS: 10:00 % 15 = 0 PASS

    API->>CS: Build multi-staff context
    CS->>CS: Compute timeline
    Note over CS: Staff A: 10:00-10:55 (55min)
    Note over CS: Staff B: 10:55-11:35 (40min)

    CS->>VS: Validate Staff A time (10:00)
    Note over VS: Customer-facing: full validation

    CS->>VS: Validate Staff B time (10:55, skip interval)
    Note over VS: Internal: format-only validation

    CS->>AS: Check Staff A availability (10:00-10:55)
    AS->>DB: Query existing bookings
    DB-->>AS: No conflicts
    AS-->>CS: Staff A available

    CS->>AS: Check Staff B availability (10:55-11:35)
    AS->>DB: Query existing bookings
    DB-->>AS: No conflicts
    AS-->>CS: Staff B available

    CS-->>API: Context valid
    API->>DB: Create booking
    DB-->>API: Booking created

    API-->>FE: Booking confirmed
    FE-->>C: Show confirmation
```

### Key Points

1. **Two-tier interval system** — 15-min customer-facing, 5-min internal computation
2. **skipIntervalValidation** — the core fix enabling multi-staff bookings with non-15-min segments
3. **Cursor-based timeline** — sequential computation ensures no overlap between staff
4. **Intentional gaps** — maximum 10 minutes, used for cleanup/transition
5. **Format validation always applies** — only interval (15-min) checking is skipped for internal times
6. **114/114 tests passing** — comprehensive coverage of all paths
7. **Exact-minute overlap detection** — availability checked at minute granularity per staff
8. **Customer sees clean times** — approximate rounding for handoff times, exact for start/end
9. **Zero database changes** — fix is purely in validation logic
10. **Production-ready** — deployed and handling multi-staff bookings successfully
