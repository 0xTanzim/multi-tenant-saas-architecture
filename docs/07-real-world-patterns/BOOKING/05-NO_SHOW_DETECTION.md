# No-Show Detection System

> **Source**: Production system
> **Risk Level**: MEDIUM — Revenue protection

## Architecture

The no-show detection runs as a cron job that checks for bookings past their start time where the customer never checked in.

### Detection Cron

- **Schedule**: Every minute
- **Grace period**: 15 minutes after booking start time
- **Distributed safety**: PostgreSQL advisory lock (`pg_try_advisory_lock(999_001)`) prevents concurrent execution across multiple instances
- **In-process safety**: `isRunning` flag prevents overlap within the same instance

### Detection Logic

For each tenant:
1. Find confirmed bookings where `checked_in_at IS NULL` and the booking start time + 15 minutes is in the past
2. The query is timezone-aware: converts booking local time to UTC, adds 15 minutes, compares with `NOW()`
3. For each overdue booking, mark as no-show within a transaction using `SELECT FOR UPDATE` for pessimistic locking

### No-Show Marking Flow

1. Lock the booking row with `SELECT ... FOR UPDATE`
2. Validate the booking can be marked (not already checked in, not already no-show, status is confirmed)
3. Resolve fee settings via 3-tier chain (tenant config → platform defaults → legacy fallback of 100%)
4. Calculate fee amount as `booking.total × (noShowPercentage / 100)`
5. Set `status = 'no_show'` and `is_no_show = true` on the booking
6. Create a `booking_payments` record with `payment_type = 'no_show_fee'`
7. Record the fee in the customer's wallet (creates debt if unpaid)
8. Log to `booking_history` with `action_type = 'no_show_marked'`

### Individual booking failures are logged but don't stop processing of other bookings.

## Key Design Decisions

- **Advisory lock gating**: The cron uses a PostgreSQL advisory lock to prevent double-firing across instances, similar to all other scheduled jobs in the system
- **Timezone-aware**: Booking times are stored in the salon's local timezone and converted to UTC for comparison
- **Retry safety**: The cron rechecks the booking status inside the locked transaction, so a booking that was cancelled between the query and the update won't be incorrectly marked
