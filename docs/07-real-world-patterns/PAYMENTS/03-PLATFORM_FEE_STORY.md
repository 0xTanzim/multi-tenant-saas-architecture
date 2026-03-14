# Portfolio Note

> Extracted from production system, sanitized for portfolio use.

---

# How Platform Fees Work — A Story-Driven Guide

> This document explains the the Platform platform fee system through real scenarios,
> tracing the journey of a fee from configuration to collection.

---

## The Big Picture

the Platform is a marketplace. organization/business owners use the platform to accept bookings; customers use it to book appointments. The **platform fee** is how the Platform earns revenue:

- **Online payments** → the platform charges a percentage fee
- **In-person payments** (cash, card at venue, MobilePay) → no platform fee

This is a deliberate business decision: the platform provides payment infrastructure for online transactions, so it takes a cut. In-person payments happen outside the platform's payment rails, so no fee applies.

---

## Chapter 1: The Admin Sets the Rate

**Actor:** Platform Admin
**Where:** Admin Settings Panel

The platform admin navigates to the settings page and sets the platform fee to **5%**. This value gets written to the `platform_configurations` table and the `financial_settings` table:

```
┌───────────────────────────────────┐
│   Admin Settings Page             │
│                                   │
│   Platform Fee Rate: [5.00] %     │
│   [Save]                          │
│                                   │
└───────────┬───────────────────────┘
            │
            ▼
    ┌───────────────────┐
    │ platform_configs   │
    │ financial_settings │
    │ platformFeeRate: 5 │
    └───────────────────┘
```

This is the **single source of truth** for the fee rate. Every booking created after this point uses this rate.

---

## Chapter 2: Emma Books a Haircut

**Actor:** Emma (Customer)
**Where:** Booking Flow

Emma finds a organization/business on the Platform and books a haircut priced at **500 DKK**. Here's what happens behind the scenes:

### Step 1: Price Calculation

When Emma submits her booking, `BookingValidationService.calculatePricing()` runs:

```
Service Price:      500.00 DKK
Tax (25% MVA):      125.00 DKK
─────────────────────────────
Subtotal:           625.00 DKK
Platform Fee (5%):   31.25 DKK   ← calculated but NOT added to Emma's total
─────────────────────────────
Emma Pays:          625.00 DKK
```

**Key insight: The platform fee is NOT charged to the customer.** It's deducted from the organization/business's payout. Emma always pays the service price + tax. The 31.25 DKK is what the Platform keeps from the organization/business's share.

### Step 2: Booking Record Created

The booking is saved to the database with the fee embedded:

```sql
INSERT INTO bookings (
  service_price,          -- 500.00
  tax_amount,             -- 125.00
  total_amount,           -- 625.00
  platform_fee_amount,    -- 31.25     ← stored on booking
  platform_fee_percentage -- 5.00      ← stored for audit trail
)
```

The fee is **frozen at booking time**. Even if the admin changes the rate tomorrow, Emma's booking keeps its original 5% fee. This prevents retroactive fee changes from affecting existing bookings.

---

## Chapter 3: Emma Pays Online (Stripe)

**Actor:** Emma (Customer)
**Where:** Payment Checkout

Emma chooses to pay online. The `PaymentService` handles the Stripe flow:

### Step 1: Resolve the Fee

```
PaymentService.resolveBookingPlatformFee()
  ├─ Query: SELECT platform_fee_amount FROM bookings WHERE id = 42
  ├─ Found: '31.25'
  └─ Return: 3125 (in cents)
```

The service reads the fee **from the booking record** — the same value calculated at booking time. This ensures consistency: what was quoted is what gets charged.

### Step 2: Create Stripe Payment Intent

```
Stripe.paymentIntents.create({
  amount: 62500,            // 625.00 DKK in cents
  currency: 'dkk',
  metadata: {
    bookingId: 42,
    tenantId: 7
  }
})
```

### Step 3: Record the Payment

After Stripe confirms the payment:

```sql
INSERT INTO booking_payments (
  booking_id:     42,
  amount:         '625.00',
  platform_fee:   '31.25',    ← fee recorded per payment
  payment_method: 'stripe',
  status:         'completed'
)
```

### The Result

```
Emma paid:           625.00 DKK  (service + tax)
Platform keeps:       31.25 DKK  (5% platform fee)
organization/business receives:      593.75 DKK  (after platform fee)
```

---

## Chapter 4: Marcus Pays at the Venue

**Actor:** Marcus (Customer)
**Where:** organization/business Reception

Marcus booked the same haircut but chooses to pay with his card at the organization/business counter. The service provider/operator processes the payment through the manager checkout.

### What Happens

```
PaymentService.confirmCardAtLocation()
  └─ platform_fee = IN_PERSON_PLATFORM_FEE = '0.00'
```

```sql
INSERT INTO booking_payments (
  booking_id:     43,
  amount:         '625.00',
  platform_fee:   '0.00',     ← zero fee for in-person
  payment_method: 'card_at_location',
  status:         'completed'
)
```

### The Result

```
Marcus paid:         625.00 DKK  (service + tax)
Platform keeps:        0.00 DKK  (no fee for in-person)
organization/business receives:      625.00 DKK  (full amount)
```

### Why No Fee?

The platform doesn't process the payment — the organization/business's own card terminal does. Since the Platform doesn't provide the payment infrastructure for in-person transactions, it doesn't charge a fee. This applies to:

- **Cash** → `confirmCashPayment()` → fee = '0.00'
- **Card at location** → `confirmCardAtLocation()` → fee = '0.00'
- **MobilePay** → `confirmMobilePayment()` → fee = '0.00'

---

## Chapter 5: The Manager Checkout (Split Payments)

**Actor:** service provider/operator/Manager
**Where:** Manager Checkout Flow

Sometimes a customer pays with multiple methods. For example, Lisa pays 400 DKK by card at the venue and 225 DKK online via Stripe.

The checkout session handles each split independently:

```
Split 1: Card at Location → 400.00 DKK → platform_fee = '0.00'
Split 2: Online (Stripe)  → 225.00 DKK → platform_fee = resolved from booking
```

Each payment method follows its own fee rules. The online portion incurs a platform fee; the in-person portion doesn't.

---

## The Architecture at a Glance

```
                                 ┌──────────────────────────┐
                                 │   financial_settings      │
                                 │   platformFeeRate: 5.00   │
                                 └───────────┬──────────────┘
                                             │ reads at
                                             │ booking time
                                             ▼
┌──────────┐     ┌─────────────────────────────────────┐     ┌──────────────┐
│ Customer │────▶│ BookingValidationService             │────▶│   bookings   │
│ books    │     │   calculatePricing()                 │     │              │
└──────────┘     │   → platformFeeAmount = total × rate │     │ fee_amount   │
                 │   → platformFeePercentage = rate     │     │ fee_percent  │
                 └─────────────────────────────────────┘     └──────┬───────┘
                                                                    │
                              ┌─────────────────────────────────────┤
                              │                                     │
                    ┌─────────▼──────────┐             ┌────────────▼────────────┐
                    │ Online Payment     │             │ In-Person Payment       │
                    │ (Stripe)           │             │ (cash/card/mobilepay)   │
                    │                    │             │                         │
                    │ resolveBooking     │             │ fee = '0.00'            │
                    │ PlatformFee()      │             │ (constant)              │
                    │ → reads from       │             │                         │
                    │   booking record   │             │                         │
                    └─────────┬──────────┘             └────────────┬────────────┘
                              │                                     │
                              ▼                                     ▼
                    ┌────────────────────────────────────────────────────────┐
                    │                  booking_payments                      │
                    │                                                        │
                    │  Online:    platform_fee = '31.25'                     │
                    │  In-person: platform_fee = '0.00'                     │
                    └────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. Fee Is Frozen at Booking Time

The fee percentage and amount are stored on the booking when it's created. This means:
- Changing the rate only affects **future** bookings
- Existing bookings keep their original fee
- The audit trail shows exactly what rate was active when the booking was made

### 2. DB-First Fee Snapshot (No Env Fallback)

The payment service reads the fee snapshot directly from the booking record. If no fee was snapshotted, it resolves as zero. This keeps fee accounting deterministic and avoids hidden environment-driven behavior.

### 3. Platform Fee ≠ Customer Surcharge

The fee is **not added** to the customer's bill. It's deducted from the organization/business's share. From the customer's perspective, the price is the price. The fee is a business arrangement between the platform and the organization/business.

### 4. In-Person Payments Are Fee-Free

This is a business model choice, not a technical limitation. The constant `IN_PERSON_PLATFORM_FEE = '0.00'` makes this explicit and easy to change if the business model evolves.

---

## Where to Find Things

| What | Where |
|------|-------|
| Fee rate config | `platform_configurations` + `financial_settings` tables |
| Fee calculation | `BookingValidationService.calculatePricing()` |
| Fee storage (booking) | `bookings.platform_fee_amount` + `bookings.platform_fee_percentage` |
| Fee resolution (payment) | `PaymentService.resolveBookingPlatformFee()` |
| Fee storage (payment) | `booking_payments.platform_fee` |
| In-person fee constant | `payments/constants/index.ts` → `IN_PERSON_PLATFORM_FEE` |
| Env var fallback | `payments/config/payments.config.ts` → `platformFeePercentage` |
| Frontend display | `checkout-flow.tsx`, booking detail pages |
| Admin settings | Platform admin settings module |
| Architecture doc | `docs/payments/PLATFORM_FEE_ARCHITECTURE.md` |

---

## FAQ

**Q: What happens if I change the fee rate?**
A: Only new bookings use the new rate. Existing bookings keep their original fee frozen at booking time.

**Q: Can I set different fees per organization/business?**
A: Yes. Per-tenant fee overrides are supported through `tenant_billing_settings`. Resolution order is: tenant override first, otherwise platform default from `platform_configurations`.

**Q: Why isn't `application_fee_amount` sent to Stripe?**
A: The platform tracks fees in its own database rather than using Stripe Connect's application fee mechanism. This gives full control over fee accounting and doesn't require a Stripe Connect marketplace setup.

**Q: What if a booking has no stored fee (legacy data)?**
A: The system treats missing snapshot values as zero during payment fee resolution.

**Q: Can the fee ever be negative?**
A: No. The fee is calculated as `totalAmount × feeRate`, where both values are non-negative. The minimum fee is 0.00 (in-person payments).
