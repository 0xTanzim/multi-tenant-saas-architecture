> **Source**: Extracted from production system, sanitized for portfolio use
> **Original**: DoneByMe Walk-In & Phone Booking Architecture
> **Status**: Production-Ready Case Study

# Walk-In and Phone Bookings — Complete Architecture

**Version:** 1.0
**Status:** Architecture Plan (Pre-Implementation)
**Date:** February 2026
**Risk Level:** MEDIUM

---

## 1. Executive Summary

Walk-in and phone bookings are staff-initiated bookings for customers who are physically present at the business or calling to schedule appointments. Unlike online bookings (customer-driven), these are created by staff **on behalf of** the customer.

### Key Differences from Online Bookings

| Dimension         | Online Booking          | Walk-In / Phone                    |
| ----------------- | ----------------------- | ---------------------------------- |
| Created by        | Customer (self-service) | Staff (on behalf of customer)      |
| Auth required     | Customer login          | Staff login + role                 |
| Card verification | Mandatory               | Optional/configurable              |
| Customer identity | Known (logged-in)       | May be new or existing             |
| Timing            | Future appointment      | Now (walk-in) or future (phone)    |
| Approval          | Configurable            | Often bypassed (customer present)  |
| Payment           | Online (Stripe)         | Cash, Card, Mobile Pay, Saved card |

### Implementation Status

| Component       | Status          |
| --------------- | --------------- |
| Backend APIs    | 90% complete ✅ |
| Database Schema | 85% complete ✅ |
| Frontend UI     | 0% complete ❌  |

---

## 2. How Walk-In Starts

### Entry Point 1: Calendar View

```
Staff clicks empty time slot
    ↓
"New Booking" drawer opens
    ↓
Staff sees customer search combobox
    ↓
Staff searches by phone/name: "+1 555-123-4567"
    ↓
If found: Select existing customer
If not found: Click "Add New Customer"
```

### Entry Point 2: New Booking Button

```
Staff clicks [+ Walk-In] or [+ Phone Booking] button
    ↓
Drawer opens with:
  - Customer search combobox
  - Service selector
  - Time selector (NOW for walk-in, future for phone)
  - Confirmation
```

---

## 3. Customer Identification Flow

### Scenario A: Existing Customer

```
Staff searches: "+1 555-123-4567"
    ↓
Backend query: SELECT * FROM customer_profiles WHERE phone = ?
    ↓
Found: "Maria Garcia" (customerId: 42)
    ↓
Staff selects Maria
    ↓
Create booking with customerId = 42
    ↓
Done! No card verification, no customer creation
```

### Scenario B: New Customer

```
Staff searches: "+1 555-123-4567"
    ↓
Not found in database
    ↓
Staff clicks "Add New Customer"
    ↓
Popup form appears:
  Name: [____________________]
  Phone: [+1 555-123-4567]
  Email: [____________________] (optional)
    ↓
Staff fills in details
    ↓
Staff clicks "Create and Book"
    ↓
Backend (ATOMIC TRANSACTION):
  1. CREATE user (no password, email optional)
  2. CREATE customer_profile (linked to user)
  3. CREATE booking (with new customerId)
    ↓
Booking created successfully ✅
```

---

## 4. Card Verification Strategy

### For Walk-Ins (Customer Present)

**Default**: NO card verification needed

Why? Customer is physically present at the business. Staff can:

- See the customer in person
- Collect payment immediately
- No-show risk is minimal

### For Phone Bookings (Customer Remote)

**Configurable** by tenant:

- Option A: NO verification (risk acceptance)
- Option B: Require card verification (reduce no-shows)

If Option B selected:

```
Backend sends email to customer:
  Subject: "Confirm your appointment"
  "Please verify your card: [button]"
    ↓
Customer clicks link
    ↓
Customer is directed to card verification page
    ↓
Customer verifies card (saves payment method)
    ↓
Booking status: confirmed ✅
```

---

## 5. Payment Collection at Checkout

### Payment Methods Available

| Method         | How It Works                                               | When Used                      |
| -------------- | ---------------------------------------------------------- | ------------------------------ |
| **Cash**       | Staff enters amount in checkout UI                         | Walk-in, customer prefers cash |
| **Card (POS)** | Customer taps/inserts card on business's physical terminal | Walk-in, card present          |
| **Mobile Pay** | Customer sends money via app (QR or number)                | Walk-in, customer has app      |
| **Saved Card** | Staff charges customer's previously verified card          | Any booking type, auto-pay     |
| **Stripe**     | Online payment (if walk-in customer wants online)          | Rare for walk-in               |

### Cash Payment Flow

```
Service completed: $50 total
    ↓
Staff clicks [Checkout]
    ↓
Checkout screen shows payment methods
    ↓
Staff selects "Cash"
    ↓
Dialog appears:
  "Customer pays: $50"
  [Amount dropdown: $50 | Custom amount]
    ↓
Staff confirms amount
    ↓
Backend records: method=cash, amount=50, status=captured ✅
```

### Card at Location (POS Terminal)

```
Service completed: $50 total
    ↓
Staff clicks [Checkout]
    ↓
Staff selects "Card at Location"
    ↓
Dialog shows:
  "Enter amount on POS terminal: $50"
    ↓
Staff enters amount on business's physical POS terminal
    ↓
Customer taps/inserts card on terminal
    ↓
Terminal confirms: "Approved ✅"
    ↓
Staff clicks "Payment Received" in our system
    ↓
Backend records: method=card_at_location, amount=50, status=captured ✅
```

**Important**: Our system RECORDS that card payment happened. We do NOT process the card. The physical terminal processed it.

### Mobile Pay / Swish Payment

```
Staff selects "Mobile Pay"
    ↓
Dialog shows:
  - QR code to scan
  - Business phone number
  - Amount: $50
    ↓
Customer scans QR or sends $50 to business's MobilePay number
    ↓
Staff receives notification: "Received $50"
    ↓
Staff clicks "Payment Received"
    ↓
Backend records: method=mobile_pay, amount=50, status=captured ✅
```

### Saved Card (Recurring/Auto-Pay)

```
Customer (Maria) has previously verified card (VISA ****4242)
    ↓
Maria walks in for another appointment
    ↓
Service completed: $50 total
    ↓
Staff clicks [Checkout]
    ↓
Staff sees "Pay Online" option (because card on file exists)
    ↓
Staff clicks "Pay Online"
    ↓
Confirmation dialog:
  "Charge VISA ****4242?"
  "⚠️ This will charge immediately"
    ↓
Staff confirms
    ↓
Backend charges saved card via Stripe (off-session):
  PaymentIntent.create({
    amount: 5000,
    payment_method: pm_xxxxx,
    off_session: true,
    confirm: true
  })
    ↓
Stripe returns: Success ✅
    ↓
Backend records: method=online, status=captured ✅
```

---

## 6. Split Payment (Multiple Methods)

```
Service completed: $80 total
Customer wants to split: $30 cash + $50 card
    ↓
Staff clicks [Checkout]
    ↓
Staff clicks "Split Payment" button
    ↓
System shows:
  Remaining: $80.00
    ↓
Staff adds payment 1:
  Method: Cash, Amount: $30
    ↓
System shows:
  Remaining: $50.00
    ↓
Staff adds payment 2:
  Method: Card, Amount: $50
    ↓
System shows:
  Remaining: $0.00 ✅
    ↓
Staff clicks "Complete Checkout"
    ↓
Backend records 2 payment records:
  - method=cash, amount=30, status=captured
  - method=card_at_location, amount=50, status=captured
    ↓
Checkout complete ✅
```

---

## 7. Account Activation (Optional)

After walk-in booking completes, customer can activate their account:

### Option 1: Email Invitation (If Email on File)

```
Booking created with customer email: maria@example.com
    ↓
Customer receives email:
  Subject: "Join [Business Name]"
  "Set up your account to view bookings and book online"
  [Create Account] button → invitation link
    ↓
Maria clicks link
    ↓
Maria creates password
    ↓
Maria's account activated ✅
    ↓
Maria can now:
  - View booking history
  - Book appointments online
  - Save payment methods
  - View reviews from past visits
```

### Option 2: In-App Activation (Future)

```
Business's website/app shows:
  "Recognized as {name}"
  [Create Account] button
    ↓
Customer fills in password
    ↓
Account activated ✅
```

---

## 8. Database Schema

### Key Tables

| Table                   | Purpose                              |
| ----------------------- | ------------------------------------ |
| `bookings`              | booking_source='walk_in' or 'phone'  |
| `customer_profiles`     | Walk-in customer records             |
| `booking_payments`      | Payment records (cash, card, mobile) |
| `booking_verifications` | Card verification tokens             |
| `user_verifications`    | Walk-in account activation tokens    |

### booking_source Values

```typescript
booking_source: 'web' | 'widget' | 'walk_in' | 'phone';
booking_type: 'online' | 'walk_in' | 'phone';
```

---

## 9. Backend Architecture

### Controllers

| Endpoint                       | Method | Purpose                      |
| ------------------------------ | ------ | ---------------------------- |
| `/bookings/staff/bookings`     | POST   | Create walk-in/phone booking |
| `/customers?search=`           | GET    | Search for existing customer |
| `/customers/walk-in`           | POST   | Create new walk-in customer  |
| `/payments/confirm-cash`       | POST   | Record cash payment          |
| `/payments/confirm-card`       | POST   | Record card payment          |
| `/payments/confirm-mobile-pay` | POST   | Record mobile pay            |
| `/payments/pay-online`         | POST   | Charge saved card            |
| `/auth/activate`               | POST   | Activate walk-in account     |

### Services

| Service                  | Purpose                         |
| ------------------------ | ------------------------------- |
| `BookingCreationService` | Handle walk-in booking creation |
| `CustomerProfileService` | Create/find walk-in customers   |
| `PaymentService`         | Process various payment methods |
| `AuthWalkInService`      | Activate walk-in accounts       |
| `BookingApprovalHandler` | Apply approval bypass rules     |

---

## 10. Frontend Components Needed

| Component                 | Purpose                          |
| ------------------------- | -------------------------------- |
| Customer search combobox  | Find or create customer          |
| New customer form         | Collect walk-in customer details |
| Service selector          | Choose services                  |
| Time selector             | Set booking time                 |
| Checkout flow             | Collect payment                  |
| Cash payment dialog       | Enter cash amount                |
| Card payment confirmation | Confirm card charge              |
| Mobile Pay QR display     | Show QR code                     |
| Split payment UI          | Multiple payment methods         |
| Confirmation screen       | Show booking details + receipt   |

---

## 11. API Contract Examples

### Create Walk-In Booking

```json
POST /tenants/:slug/bookings/staff/bookings
{
  "bookingSource": "walk_in",
  "customerId": 42,
  "services": [{"id": 123, "duration": 60}],
  "staffId": 5,
  "bookingDate": "2026-02-18",
  "startTime": "14:30",
  "customerName": "Maria Garcia",
  "customerPhone": "+1-555-123-4567",
  "customerEmail": "maria@example.com",
  "notes": "First time customer"
}

Response: {
  "id": 999,
  "bookingNumber": "BK-20260218-999",
  "status": "confirmed",
  "customerId": 42
}
```

### Confirm Cash Payment

```json
POST /tenants/:slug/payments/confirm-cash
{
  "bookingId": 999,
  "amount": 50.00,
  "currency": "USD"
}

Response: {
  "paymentId": 2401,
  "method": "cash",
  "amount": 50.00,
  "status": "captured"
}
```

### Charge Saved Card

```json
POST /tenants/:slug/payments/pay-online
{
  "bookingId": 999,
  "customerId": 42,
  "amount": 50.00
}

Response: {
  "paymentId": 2402,
  "method": "online",
  "amount": 50.00,
  "status": "captured",
  "cardLast4": "4242"
}
```

---

## 12. Edge Cases

### Edge Case 1: Walk-In No Email

```
Walk-in customer: No email provided
    ↓
Booking created successfully
    ↓
No activation email sent (no email address)
    ↓
Customer can't activate account remotely
    ↓
Staff can manually share activation link or collect email later
```

### Edge Case 2: Duplicate Phone Numbers

```
Two customers with same phone number exist in system
    ↓
Staff searches: "+1 555-123-4567"
    ↓
System shows both customers:
  "Maria Garcia (last booked Feb 18)"
  "Mark Smith (last booked Jan 12)"
    ↓
Staff selects correct one
```

### Edge Case 3: Payment Method Unavailable

```
Staff tries to charge customer's saved card
    ↓
Card declined / expired
    ↓
System shows error: "Card declined"
    ↓
Staff can:
  - Try different payment method
  - Ask customer to update card
  - Accept different payment type
```

---

## 13. Implementation Phases

### Phase 1: Customer Search & Walk-In Creation (Week 1)

- Customer search combobox
- New customer form in drawer
- Atomic booking + customer creation
- UI wired to backend APIs

### Phase 2: Payment Collection (Week 2)

- Cash payment dialog
- Card payment confirmation
- Mobile Pay QR display
- Split payment UI

### Phase 3: Account Activation (Week 3)

- Activation email template
- Activation page UI
- Password creation flow
- Account linking

### Phase 4: Testing & Polish (Week 4)

- End-to-end flow testing
- Edge case handling
- Performance optimization
- Error handling improvements

---

## 14. Success Criteria

- [ ] Walk-in booking created in < 2 minutes
- [ ] Customer search works with phone/name
- [ ] Payment collected via multiple methods
- [ ] Zero payment processing errors
- [ ] Activation email delivers within 5 minutes
- [ ] Staff can manage walk-in bookings from calendar
- [ ] Support tickets about walk-in bookings < 3% of total
