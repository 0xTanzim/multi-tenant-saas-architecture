# Platform Fee Snapshotting

> **Source**: Production system
> **Risk Level**: HIGH — Money integrity

## Why Snapshot?

Platform fees are calculated at booking creation and **never modified**. This prevents disputes about what the fee was at the time of booking versus what it is now.

## How It Works

### Fee Rate Resolution (2-Tier)

1. **Per-tenant override** (`tenant_billing_settings` table) — if a tenant has a custom fee rate set by an admin
2. **Global default** (`platform_configurations` table) — the platform-wide fee rate

### Snapshot at Creation

Two fields on the `bookings` table capture the fee at creation time:

```typescript
platform_fee_amount: decimal      // The calculated fee in currency
platform_fee_percentage: decimal  // The rate that was applied (e.g., 5.00 for 5%)
```

These are set in `booking-persistence.service.ts` at insert time and never updated after that.

### Fee Calculation

```
taxableAmount = servicePrice - discountAmount
platformFee = taxableAmount × platformFeeRate
totalAmount = taxableAmount + tax  // Platform fee is separate from customer total
```

The platform fee is **not** added to the customer's total. It represents the platform's cut of the transaction, stored for settlement reporting.

### Payment Recording

The same fee is also stored in `booking_payments.platform_fee` when the initial payment intent is recorded.

### Finance Aggregation

The finance module aggregates platform fees across tenants for admin reporting:

```sql
SELECT tenant_id, SUM(platform_fee) as total_fees
FROM booking_payments
GROUP BY tenant_id;
```

## Key Design Decision

Fees are **immutable after creation**. Even if an admin changes the rate in the future, existing bookings keep their original fee. This is enforced by the code never updating `platform_fee_amount` or `platform_fee_percentage` after the initial insert.
