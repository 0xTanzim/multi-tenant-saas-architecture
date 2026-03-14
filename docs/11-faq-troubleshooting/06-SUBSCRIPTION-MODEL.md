# FAQ: Subscription Model & Billing Architecture

**Last Updated**: 2025-10-15
**Status**: Active

---

## Overview

The platform supports **two parallel subscription models**:

1. **B2B Tenant Subscriptions** — Service provider businesses subscribe to use the platform
2. **B2C Customer Memberships** — Customers purchase memberships/loyalty programs from businesses

These operate independently but can interact (e.g., loyal members get discounts).

---

## Part 1: B2B Tenant Subscriptions

### The Model: "Gym Franchise" Analogy

Imagine owning a gym franchise. Each franchise location is a separate business entity:

- **Franchise Owner (Tenant)** subscribes to platform at a specific tier
- **Subscription tier** determines features available: staff management, advanced reports, widgets, etc.
- **Customers** (gym members) book classes at that franchise
- **Billing** happens monthly, charged to the franchise owner

```
Platform Billing
├── Tenant 1 (Yoga Studio): Professional tier = $299/month
├── Tenant 2 (Hair Salon): Starter tier = $99/month
└── Tenant 3 (Fitness Center): Enterprise tier = Custom pricing
```

### Database Schema

```sql
-- Subscription tiers (immutable platform configuration)
CREATE TABLE subscription_tiers (
  id UUID PRIMARY KEY,
  code VARCHAR(50) UNIQUE,  -- "free", "starter", "professional", "enterprise"
  name VARCHAR(100),        -- "Professional"
  monthly_price DECIMAL(10, 2),
  annual_price DECIMAL(10, 2),

  features JSONB,  -- {
           --   "max_staff": 50,
           --   "advanced_reports": true,
           --   "custom_branding": false,
           --   "api_access": false
           -- }

  stripe_price_id VARCHAR(255),  -- Stripe product ID
  is_active BOOLEAN DEFAULT true
);

-- Tenant subscriptions (per-tenant billing)
CREATE TABLE tenant_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,

  tier_id UUID NOT NULL REFERENCES subscription_tiers(id),
  billing_cycle VARCHAR(20),  -- "monthly" or "annual"

  stripe_subscription_id VARCHAR(255),  -- Stripe subscription ID
  stripe_customer_id VARCHAR(255),      -- Stripe customer ID

  status VARCHAR(20),  -- "active", "canceled", "past_due"

  current_period_start DATE,
  current_period_end DATE,

  renewal_date DATE,
  auto_renew BOOLEAN DEFAULT true,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_tenant_subscriptions_status (tenant_id, status)
);

-- Subscription history (audit trail)
CREATE TABLE subscription_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),

  change_type VARCHAR(20),  -- "upgrade", "downgrade", "renew", "cancel"
  from_tier_id UUID REFERENCES subscription_tiers(id),
  to_tier_id UUID REFERENCES subscription_tiers(id),

  effective_date DATE,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Tier Configuration Example

| Feature                | Free | Starter   | Professional   | Enterprise |
| ---------------------- | ---- | --------- | -------------- | ---------- |
| **Monthly Price**      | $0   | $99       | $299           | Custom     |
| **Annual Discount**    | —    | 20%       | 25%            | 30%        |
| Max staff              | 3    | 10        | 50             | Unlimited  |
| Booking calendar       | ✅   | ✅        | ✅             | ✅         |
| Customer notifications | SMS  | Email+SMS | Email+SMS+Push | All        |
| Advanced reports       | ❌   | ❌        | ✅             | ✅         |
| API access             | ❌   | ❌        | ✅             | ✅         |
| Custom domain          | ❌   | ❌        | ❌             | ✅         |
| Dedicated support      | ❌   | ❌        | ❌             | ✅         |

### Upgrade / Downgrade Flow

```typescript
// Tenant wants to upgrade from Starter → Professional
const upgrade = async (tenantId: string, newTierId: string) => {
  // 1. Load current subscription
  const subscription = await tenantSubscriptionRepository.findByTenant(
    tenantId
  );
  const currentTier = subscription.tier;

  // 2. Create Stripe subscription update
  const stripeUpdated = await stripe.subscriptions.update(
    subscription.stripeSubscriptionId,
    {
      items: [
        {
          id: subscription.stripeItemId,
          price: newTier.stripePriceId, // Switch to new tier's price
        },
      ],
      proration_behavior: 'create_prorations', // Charge for upgrade immediately
    }
  );

  // 3. Update database
  await tenantSubscriptionRepository.update(tenantId, {
    tier_id: newTierId,
    stripe_subscription_id: stripeUpdated.id,
  });

  // 4. Audit log
  await subscriptionChangesRepository.create({
    tenant_id: tenantId,
    change_type: 'upgrade',
    from_tier_id: currentTier.id,
    to_tier_id: newTierId,
    effective_date: new Date(),
  });

  // 5. Emit event (triggers notification, feature unlock, etc.)
  eventEmitter.emit('subscription.upgraded', {
    tenantId,
    fromTier: currentTier.code,
    toTier: newTier.code,
  });
};
```

### Billing Webhook Handler

Stripe sends webhooks for subscription events:

```typescript
@Post('/webhooks/stripe')
async handleStripeWebhook(@Body() event: Stripe.Event) {
  switch (event.type) {
    case 'customer.subscription.created':
      // New subscription started
      break;

    case 'customer.subscription.updated':
      // Tier changed, billing cycle changed, etc.
      const subscription = event.data.object;
      await tenantSubscriptionRepository.update(subscription.metadata.tenantId, {
        stripe_subscription_id: subscription.id,
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
      });
      break;

    case 'invoice.payment_succeeded':
      // Payment processed
      break;

    case 'invoice.payment_failed':
      // Payment failed, maybe retry
      break;

    case 'customer.subscription.deleted':
      // Subscription cancelled
      break;
  }
}
```

---

## Part 2: B2C Customer Memberships

### The Model: "Loyalty Tiers"

Customers (end-users) can purchase memberships at a business:

- **Customer** buys a "Gold Member" package from a salon
- **Package** provides benefits: discounts, priority booking, free services
- **Billing** charged to customer's payment method
- **Benefits** enforced at booking time (check tier → apply discount)

```
Customer Memberships
├── John @ Salon A: Gold Member ($49/month)
│   ├── 15% off all services
│   ├── Free haircut once per month
│   └── Priority booking (1-week advance)
└── John @ Salon B: Bronze Member ($9/month)
    ├── 5% off services
    └── Basic booking
```

### Database Schema

```sql
-- Customer membership packages (per tenant, per package tier)
CREATE TABLE customer_membership_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  name VARCHAR(100),  -- "Gold Member", "VIP", "Premium"
  code VARCHAR(50),
  tier_level INT,     -- 1 (Bronze) to 4 (Platinum)

  monthly_price DECIMAL(10, 2),
  annual_price DECIMAL(10, 2),

  benefits JSONB,  -- {
          --   "discount_percent": 15,
          --   "free_service_monthly": "haircut",
          --   "priority_booking_days": 7
          -- }

  stripe_price_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Customer memberships (actual enrollments)
CREATE TABLE customer_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES users(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  package_id UUID NOT NULL REFERENCES customer_membership_packages(id),

  stripe_subscription_id VARCHAR(255),

  status VARCHAR(20),  -- "active", "cancelled", "expired"

  joined_date DATE,
  renewal_date DATE,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(customer_id, tenant_id, package_id)
);

-- Membership benefits tracking (audit)
CREATE TABLE membership_benefits_used (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id UUID NOT NULL REFERENCES customer_memberships(id),
  booking_id UUID NOT NULL REFERENCES bookings(id),

  benefit_type VARCHAR(50),  -- "discount", "free_service", etc.
  benefit_value DECIMAL(10, 2),

  redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Membership + Booking Integration

When customer books:

```typescript
// 1. Check if customer has active membership at this salon
const membership = await customerMembershipRepository.findActive(
  customerId,
  tenantId // salon
);

// 2. If member, apply benefits
if (membership) {
  const benefits = membership.package.benefits;

  let discountAmount = 0;
  if (benefits.discountPercent) {
    discountAmount = (bookingTotal * benefits.discountPercent) / 100;
  }

  // 3. Apply free service if used this month
  if (benefits.freeServiceMonthly) {
    const usedThisMonth = await membershipBenefitsRepository.count({
      membership_id: membership.id,
      benefit_type: 'free_service',
      redeemed_at: { gte: currentMonthStart },
    });

    if (usedThisMonth < 1) {
      discountAmount += freeServiceValue; // Add free service value
    }
  }

  // 4. Apply discount to booking
  booking.discount_amount = discountAmount;
  booking.discount_source = 'membership';
}

// 5. Complete booking
await bookingRepository.create(booking);
```

---

## Part 3: Revenue Model

### Tenant Revenue (What Platform Earns)

Platform earns from tenant subscriptions:

```
Revenue = Number of Tenants × Average Tier Price
Example: 500 tenants × avg $200/month = $100k/month
```

### Customer Revenue (What Platform Earns from Memberships)

Platform takes a cut of customer membership subscriptions:

```
Revenue Share Model:
├── Monthly Membership: $49
├── Platform Fee (-15%): -$7.35
├── To Business: $41.65

Platform earns: 15% × $49 × active memberships
```

### Churn Metrics

**Tenant Churn Rate**: (Canceled tenants / Active tenants at start of month) × 100

```
Typical targets:
- Free tier: 5-10% monthly churn (expected, low commitment)
- Paid tiers: 2-5% monthly churn (acceptable)
- < 2% monthly churn: Excellent retention
```

**Customer Churn Rate**: Similar calculation for customer memberships

```
Strategy to reduce churn:
- Better onboarding (feature discovery)
- Win-back campaigns (email re-engagement)
- Quality improvements (fewer bugs)
- Feature releases (keep engaged)
```

---

## Part 4: Common Scenarios

### Scenario 1: Tenant Upgrades

1. Tenant views dashboard → clicks "Upgrade to Professional"
2. Redirected to Stripe payment page (maintained context)
3. Tenant enters card, completes payment
4. Stripe webhook → platform updates subscription tier
5. Tenant immediately gains access to new features (feature flags checked)
6. Notification sent: "Upgrade successful! New features available"

### Scenario 2: Stripe Payment Fails

1. Subscription renewal date arrives
2. Stripe attempts charge → Fails (card expired)
3. Stripe webhook: `invoice.payment_failed`
4. Platform sends email to tenant: "Payment failed. Update payment method"
5. Stripe retries automatically (configurable)
6. If all retries fail, subscription enters `past_due` state
7. Tenant services degrade (read-only mode or full pause)

### Scenario 3: Customer Enrolls in Membership

1. Customer visits salon page on platform
2. Sees "Gold Member - $49/month" offer
3. Clicks "Join" → Stripe payment modal
4. Successful charge → `customer_memberships` record created
5. Booking discount automatically applied on next booking
6. Monthly email summary: "This month saved $X with your membership"

### Scenario 4: Annual Billing

1. Tenant selects "Annual" billing (20% discount)
2. Charged full year upfront: $2,388 for Professional ($199/month × 12)
3. Stripe subscription set to 1-year renewal
4. At 1-year mark, automatically charges for next year
5. Tenant can downgrade/cancel anytime (prorations handled by Stripe)

---

## Stripe Integration Details

### Payment Method Setup

```typescript
// Tenant clicks "Upgrade" → Redirects to Stripe checkout
const session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'],
  customer: tenantStripeCustomerId, // or create new

  line_items: [
    {
      price: newTier.stripePriceId,
      quantity: 1,
    },
  ],

  billing_cycle_anchor: Math.floor(Date.now() / 1000), // Start today

  mode: 'subscription', // Recurring billing

  success_url: 'https://platform.com/dashboard?success=true',
  cancel_url: 'https://platform.com/plans',
});

// Redirect tenant to Stripe
return { checkoutUrl: session.url };
```

### Handling Prorations

When upgrading mid-cycle:

```
Previous Billing: $99/month Professional (renews June 15)
Today is: June 1
Upgrade to: $299/month Pro

Proration:
├── Refund: -$99 × 14 days / 30 days = -$46.20 (credit for unused days)
├── New charge: $299 × 14 days / 30 days = $139.67 (new tier for remaining days)
├── Net charge: $139.67 - $46.20 = $93.47 (today)
└── Next renewal: June 15 @ $299.00
```

---

## Billing Reporting

### Dashboard KPIs

```
Tenants by Tier:
├── Free: 5,000 (70%)
├── Starter: 1,500 (21%)
├── Professional: 450 (6%)
└── Enterprise: 50 (0.7%)

Monthly Recurring Revenue (MRR):
├── Starter: 1,500 × $99 = $148,500
├── Professional: 450 × $299 = $134,550
├── Enterprise: 50 × $2,500 = $125,000
└── **Total MRR: $408,050**

Churn Rate: 3.2% monthly (7% annualized)
LTV (Customer Lifetime Value): $5,312 @ 3.2% churn
CAC (Cost to Acquire): ~$500 (marketing + onboarding)
LTV/CAC Ratio: 10.6x (healthy: >3x)
```

---

## Summary

**B2B Tenant Subscriptions:**

- Service providers pay monthly/annually for platform access
- Tiers provide increasing features
- Billing managed via Stripe
- Revenue model: fixed monthly price × active subscriptions

**B2C Customer Memberships:**

- End-users pay for loyalty/discount packages
- Platform takes revenue share (15%)
- Benefits automatically applied at booking
- Grows stickiness (customers stay for discounts)

Together, these create **dual revenue streams** and higher **customer lifetime value**.
