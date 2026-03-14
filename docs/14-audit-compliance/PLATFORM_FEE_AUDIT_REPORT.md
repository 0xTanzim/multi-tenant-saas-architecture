# Payments & Platform Fee — Comprehensive Audit Report

**Date:** 2025-07-19
**Scope:** Full backend audit of platform fee flow, Stripe integration, dashboard/analytics impact, invoice/transaction effects
**Request:** Validate PLATFORM_FEE_STORY.md against actual implementation

---

## Executive Summary

The platform fee **calculation, storage, and per-tenant resolution** are correctly implemented. However, the system has **7 critical gaps** between the story document and reality, and between what the code does and what the partner sees. The story document (`PLATFORM_FEE_STORY.md`) contains **factual inaccuracies** about how the fee affects the customer total and is **outdated** regarding per-tenant configuration.

---

## STORY VALIDATION — Is PLATFORM_FEE_STORY.md Valid?

### ❌ INVALID: "Platform fee is NOT charged to the customer"

**Story says (Chapter 2):**
> "Platform Fee (5%): 31.25 DKK ← calculated but NOT added to Emma's total"
> "Emma Pays: 625.00 DKK" (service 500 + tax 125)

**Code reality** (`booking-validation.service.ts` line 156):
```typescript
const totalAmount = taxableAmount + taxAmount + platformFeeAmount;
// = 500 + 125 + 31.25 = 656.25 DKK
```

**VERDICT:** The platform fee IS added to `total_amount`. Emma actually pays **656.25 DKK**, not 625.00. The story's core premise that "the fee is deducted from the salon's share" is **incorrect** — the fee is added on top of what the customer pays.

### ❌ INVALID: "Fee ≠ Customer Surcharge"

**Story says (Key Design Decisions #3):**
> "The fee is not added to the customer's bill. It's deducted from the salon's share."

**Reality:** The code adds `platformFeeAmount` directly to `totalAmount`, which IS the customer's bill.

### ❌ OUTDATED: "Can I set different fees per salon?"

**Story FAQ says:**
> "Currently, the fee rate is platform-wide. Per-tenant rates would require adding a platform_fee_rate column to the tenants table."

**Reality:** Per-tenant fee overrides are fully implemented via `tenant_billing_settings` table and `TenantBillingModule`.

### ✅ VALID: Fee frozen at booking time
Correctly implemented. `platform_fee_amount` and `platform_fee_percentage` stored at creation.

### ✅ VALID: In-person payments are fee-free
`confirmCashPayment`, `confirmCardAtLocation`, `confirmMobilePayment` all use `IN_PERSON_PLATFORM_FEE = '0.00'`.

### ✅ VALID: Online payments resolve fee from booking
`resolveBookingPlatformFee()` reads from booking record.

### ⚠️ PARTIALLY VALID: DB-First with env var fallback
Env var fallback was removed. `resolveBookingPlatformFee()` returns 0 if no fee exists.

---

## QUESTION-BY-QUESTION ANSWERS

### Q1: "When Stripe payment comes in, is the platform fee counted?"

**YES.** The fee is calculated at booking creation and stored on the booking. When online payment happens, `resolveBookingPlatformFee()` reads it from the booking and stores it on `booking_payments.platform_fee`.

However: the fee is already baked into `total_amount` that the customer pays. Stripe only sees `total_amount` — no `application_fee_amount` or `transfer_data`.

### Q2: "Balance comes to global wallet, then admin sends to salon?"

**NO. This infrastructure does not exist.**

- No wallet/balance model for money (wallet is loyalty-only)
- No Stripe Connect (no connected accounts, no split payments)
- No payout/settlement execution (`findForSettlement`/`markAsSettled` exist but are unwired)
- No bank account collection for salons
- All money lands in one platform Stripe account with no automated distribution

### Q3: "How will salon overview/reports/analytics calculate?"

**All show GROSS revenue including platform fee:**

| Surface | Source | Net Revenue? |
|---|---|---|
| Dashboard today/monthly | `SUM(bookings.total_amount)` | ❌ NO |
| Revenue trend | MV `completed_revenue` | ❌ NO |
| Analytics reports | MV `completed_revenue` | ❌ NO |
| Transaction summary | `SUM(booking_payments.amount)` | ❌ NO |
| **Payment reconciliation** | `amount - platform_fee - gateway_fee - refunds` | ✅ YES |
| **Finance admin** | Per-tenant with separate fee totals | ✅ Derivable |

### Q4: "Backend configured for per-tenant OR global?"

**BOTH — fully implemented.** Resolution order:
1. Check `tenant_billing_settings` for the tenant
2. If override exists → use per-tenant rate
3. Otherwise → use global `platform_configurations` rate

### Q5: "Is the backend ready?"

| Component | Status |
|---|---|
| Fee calculation & storage | ✅ Ready |
| Per-tenant override resolution | ✅ Ready |
| Online/in-person fee handling | ✅ Ready |
| Admin CRUD for overrides | ✅ Ready |
| **Stripe Connect / split payments** | ❌ NOT BUILT |
| **Automated salon payouts** | ❌ NOT BUILT |
| **Wallet/balance system** | ❌ NOT BUILT |
| **Partner net revenue dashboard** | ❌ NOT BUILT |
| **Settlement pipeline** | ❌ NOT BUILT |

### Q6: "Partner dashboard statistics/reports affected?"

**YES — partner sees inflated revenue.** `todayRevenue` and `monthlyRevenue` use `SUM(total_amount)` which includes platform fee. Partner has no way to see net earnings.

### Q7: "Invoice & transactions affected?"

**Invoices:** Correctly show customer amounts (no platform fee — correct for B2C).
**Transactions:** Show gross amounts. `platform_fee` exists per record but isn't displayed or subtracted.

---

## CRITICAL FINDING: total_amount Includes Platform Fee

```typescript
// booking-validation.service.ts line 156
const totalAmount = taxableAmount + taxAmount + platformFeeAmount;
```

**The design decision must be made:**

**Option A: Fee IS customer surcharge (current code)**
- Customer pays: service + tax + platformFee = 656.25
- Salon gets: 625.00 (total_amount - platformFee)
- Dashboard needs: show `total_amount - platform_fee_amount`

**Option B: Fee is deducted from salon share (story intent)**
- Customer pays: service + tax = 625.00
- Salon gets: 593.75 (total_amount - platformFee)
- Code fix: `totalAmount = taxableAmount + taxAmount`

---

## RECOMMENDATIONS

### P0: Fix Story or Fix Code
Align the story document with the actual code behavior, or change the code to match the story intent.

### P1: Fix Dashboard/Analytics Revenue
Add net revenue calculation: gross - platform_fee - gateway_fee

### P2: Design Payout Pipeline
Stripe Connect vs manual settlement tracking

### P3: Update Story Document
Fix inaccuracies about customer surcharge, per-tenant support, env var fallback
