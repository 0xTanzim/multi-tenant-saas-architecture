# Concurrency Architecture: Three-Layer Slot Protection

> **Source**: Production system
> **Risk Level**: HIGH — Prevents double-booking and race conditions

## The Problem

Two customers can hit the same 3:00 PM time slot simultaneously. Both read "available" from the cache and both attempt to book. Without proper concurrency controls, both succeed and you get a double-booking.

## The Solution: Three Layers of Defense

No single layer is perfect. Each catches a different failure mode.

### Layer 1: Database Unique Constraint (The Safety Net)

```sql
CREATE UNIQUE INDEX uq_booking_active_slot
  ON bookings (tenant_id, primary_staff_employment_id, booking_date, start_time)
  WHERE deleted_at IS NULL;
```

This is the last line of defense. It prevents two active (non-deleted) bookings for the same staff at the same time, at the row level. If application logic fails, this catches it.

### Layer 2: Redis Distributed Locks (The Gate)

When a customer starts the booking flow, a temporary hold is placed on the slot using Redis distributed locks:

```
SET slot_lock:{tenant}:{staff}:2025-03-25:15:00 <token> PX 5000 NX
```

- **SET NX** ensures only one hold succeeds
- **PX 5000** auto-expires the lock after 5 seconds (dead customer doesn't block the slot forever)
- **Token verification** with Lua script prevents accidental release by another process
- **5 retries** with 75ms delay (~375ms total wait) if the lock is held

### Layer 3: SELECT FOR UPDATE (The Transaction Guard)

Inside the booking creation transaction, a pessimistic lock serializes writes:

```sql
SELECT id, start_time, end_time, status
FROM bookings
WHERE tenant_id = ? AND primary_staff_employment_id = ?
  AND booking_date = ? AND deleted_at IS NULL
  AND status IN ('confirmed', 'in_progress', 'pending_approval')
  AND (start_time, end_time) OVERLAPS (?, ?)
FOR UPDATE;
```

This ensures that even if two transactions enter the booking creation flow simultaneously, one waits for the other to complete before proceeding.

### Multi-Staff Booking Conflicts

For per-service staff assignments, a separate check groups services by staff:

```sql
SELECT ... FROM booking_services
WHERE tenant_id = ?
  AND staff_employment_id IN (?)
  AND booking_date = ?
  AND (estimated_start_time, estimated_end_time) OVERLAPS (?, ?)
FOR UPDATE;
```

### Read Path

Availability reads stay fast through the Redis cache. The three layers only serialize writes.

| Layer | What It Prevents | Failure Mode |
|-------|-----------------|--------------|
| Unique constraint | Application bugs, missed WHERE clauses | Catches everything at DB level |
| Redis locks | Timing races during simultaneous booking | Auto-expires if customer walks away |
| SELECT FOR UPDATE | Edge cases inside transactions | Blocks until first write completes |

## Why Not Just Optimistic Locking?

Optimistic locking (version columns) doesn't work here. Both concurrent reads see the same version number, both increment it, and you still get a double-booking. Pessimistic strategies are the correct choice for slot contention.
