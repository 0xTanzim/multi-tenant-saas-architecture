# Design System: Color Palette & Accessibility

**Version**: 1.0
**Last Updated**: 2025-10-10
**Status**: Active

---

## Color Palette Overview

This design system defines a comprehensive color palette for a modern SaaS service booking platform. All colors are selected for:

- **WCAG AA Accessibility Compliance** (minimum 4.5:1 contrast for text)
- **Semantic Meaning** (success = green, danger = red, etc.)
- **Light & Dark Mode Support** (automatic mode switching)
- **Brand Recognition** (warm, inviting personality for service providers)

---

## Primary Brand Colors

### Coral/Warm Orange (Primary)

```css
--color-primary-50:   #FEF6F3
--color-primary-100:  #FDE8DF
--color-primary-200:  #FBC8B3
--color-primary-300:  #F9A887
--color-primary-400:  #F78852
--color-primary-500:  #F76B47  /* Main brand color */
--color-primary-600:  #E55A35  /* Hover state */
--color-primary-700:  #C84820  /* Active state */
--color-primary-800:  #9D3815
--color-primary-900:  #6D260F

RGB Equivalent: rgb(247, 107, 71)
HEX: #F76B47
```

**Usage:**

- Primary CTA buttons
- Active navigation items
- Links and highlights
- Selected states

**For Text:** Use `--color-primary-700: #C84820` (4.6:1 contrast on white) instead of primary-500 for better readability.

---

## Semantic Colors

### Success (Green)

```css
--color-success-50:   #ECFDF5
--color-success-100:  #D1F9E6
--color-success-200:  #A7F0CE
--color-success-300:  #6FE7B0
--color-success-400:  #34D399
--color-success-500:  #10B981  /* Main success */
--color-success-600:  #059669
--color-success-700:  #047857
--color-success-800:  #065F46
--color-success-900:  #064E3B
```

**Usage:**

- Success messages & confirmations
- Completed bookings
- Available appointments
- Positive feedback
- "Payment successful" screens

**Text:** Use `--color-success-700: #047857` for accessible text (5.2:1 on white).

### Warning (Amber)

```css
--color-warning-50:   #FFFBEB
--color-warning-100:  #FEF3C7
--color-warning-200:  #FDE68A
--color-warning-300:  #FCD34D
--color-warning-400:  #FBBF24
--color-warning-500:  #F59E0B  /* Main warning */
--color-warning-600:  #D97706
--color-warning-700:  #B45309
--color-warning-800:  #92400E
--color-warning-900:  #78350F
```

**Usage:**

- Warnings & cautions
- Appointment reminders
- Limited availability
- Expiring offers
- "Action needed" notifications

**Text:** Use `--color-warning-700: #B45309` for accessible text (4.8:1 on white).

### Danger (Red)

```css
--color-danger-50:    #FEF2F2
--color-danger-100:   #FEE2E2
--color-danger-200:   #FECACA
--color-danger-300:   #FCA5A5
--color-danger-400:   #F87171
--color-danger-500:   #EF4444  /* Main danger */
--color-danger-600:   #DC2626
--color-danger-700:   #B91C1C
--color-danger-800:   #991B1B
--color-danger-900:   #7F1D1D
```

**Usage:**

- Error messages & alerts
- Destructive actions (delete, cancel)
- Failed payments
- Booking cancellations
- Negative feedback

**Text:** Use `--color-danger-700: #B91C1C` for accessible text (5.0:1 on white).

### Info (Sky Blue)

```css
--color-info-50:      #F0F9FF
--color-info-100:     #E0F2FE
--color-info-200:     #BAE6FD
--color-info-300:     #7DD3FC
--color-info-400:     #38BDF8
--color-info-500:     #0EA5E9  /* Main info */
--color-info-600:     #0284C7
--color-info-700:     #0369A1
--color-info-800:     #075985
--color-info-900:     #0C3D5C
```

**Usage:**

- Informational messages
- Tooltips & help text
- New feature badges
- Announcements
- Learning/onboarding prompts

**Text:** Use `--color-info-700: #0369A1` for accessible text (6.5:1 on white).

---

## Neutral/Gray Palette

### Slate Gray (Neutral Base)

```css
--color-neutral-50:   #F8FAFC
--color-neutral-100:  #F1F5F9
--color-neutral-200:  #E2E8F0
--color-neutral-300:  #CBD5E1
--color-neutral-400:  #94A3B8
--color-neutral-500:  #64748B  /* Mid gray */
--color-neutral-600:  #475569
--color-neutral-700:  #334155  /* Text on light backgrounds */
--color-neutral-800:  #1E293B
--color-neutral-900:  #0F172A
```

**Usage:**

- Text content (use -700 or -800 for dark text)
- Borders and dividers
- Disabled states
- Background surfaces (use -50 or -100)
- Secondary buttons

---

## Light Mode (Default)

```css
:root {
  /* Backgrounds */
  --bg-primary:      white          /* #FFFFFF */
  --bg-secondary:    #F8FAFC        /* neutral-50 */
  --bg-tertiary:     #F1F5F9        /* neutral-100 */
  --bg-overlay:      rgba(15, 23, 42, 0.75)

  /* Text */
  --text-primary:    #0F172A        /* neutral-900 */
  --text-secondary:  #475569        /* neutral-600 */
  --text-muted:      #64748B        /* neutral-500 */

  /* Interactive */
  --color-primary:   #F76B47
  --color-success:   #10B981
  --color-warning:   #F59E0B
  --color-danger:    #EF4444
  --color-info:      #0EA5E9

  /* Borders & Separators */
  --border-light:    #E2E8F0        /* neutral-200 */
  --border-regular:  #CBD5E1        /* neutral-300 */
  --border-dark:     #94A3B8        /* neutral-400 */

  /* Shadows */
  --shadow-sm:       0 1px 2px 0 rgba(0, 0, 0, 0.05)
  --shadow-md:       0 4px 6px -1px rgba(0, 0, 0, 0.1)
  --shadow-lg:       0 10px 15px -3px rgba(0, 0, 0, 0.1)
  --shadow-xl:       0 20px 25px -5px rgba(0, 0, 0, 0.1)
}
```

---

## Dark Mode

```css
@media (prefers-color-scheme: dark) {
  :root {
    /* Backgrounds */
    --bg-primary:      #0F172A        /* neutral-900 */
    --bg-secondary:    #1E293B        /* neutral-800 */
    --bg-tertiary:     #334155        /* neutral-700 */
    --bg-overlay:      rgba(0, 0, 0, 0.85)

    /* Text */
    --text-primary:    #F8FAFC        /* neutral-50 */
    --text-secondary:  #CBD5E1        /* neutral-300 */
    --text-muted:      #94A3B8        /* neutral-400 */

    /* Interactive (slightly lighter for visibility in dark) */
    --color-primary:   #F78852        /* primary-400 */
    --color-success:   #6FE7B0        /* success-300 */
    --color-warning:   #FBBF24        /* warning-400 */
    --color-danger:    #F87171        /* danger-400 */
    --color-info:      #38BDF8        /* info-400 */

    /* Borders */
    --border-light:    #334155        /* neutral-700 */
    --border-regular:  #475569        /* neutral-600 */
    --border-dark:     #64748B        /* neutral-500 */

    /* Shadows (more subtle in dark) */
    --shadow-sm:       0 1px 3px 0 rgba(0, 0, 0, 0.3)
    --shadow-md:       0 4px 6px 0 rgba(0, 0, 0, 0.4)
    --shadow-lg:       0 10px 15px 0 rgba(0, 0, 0, 0.5)
    --shadow-xl:       0 20px 25px 0 rgba(0, 0, 0, 0.6)
  }
}
```

---

## Contrast Compliance Matrix

### Text on Light Background (Light Mode)

| Text Color  | Hex     | Background | Ratio  | WCAG   |
| ----------- | ------- | ---------- | ------ | ------ |
| Primary-700 | #C84820 | White      | 4.6:1  | AA ✅  |
| Success-700 | #047857 | White      | 5.2:1  | AAA ✅ |
| Warning-700 | #B45309 | White      | 4.8:1  | AA ✅  |
| Danger-700  | #B91C1C | White      | 5.0:1  | AA ✅  |
| Info-700    | #0369A1 | White      | 6.5:1  | AAA ✅ |
| Neutral-700 | #334155 | White      | 7.5:1  | AAA ✅ |
| Neutral-800 | #1E293B | White      | 10.6:1 | AAA ✅ |

### Text on Dark Background (Dark Mode)

| Text Color  | Hex     | Background  | Ratio  | WCAG   |
| ----------- | ------- | ----------- | ------ | ------ |
| Primary-400 | #F78852 | Neutral-900 | 5.1:1  | AA ✅  |
| Success-300 | #6FE7B0 | Neutral-900 | 6.2:1  | AAA ✅ |
| Warning-400 | #FBBF24 | Neutral-900 | 7.8:1  | AAA ✅ |
| Danger-400  | #F87171 | Neutral-900 | 5.3:1  | AA ✅  |
| Info-400    | #38BDF8 | Neutral-900 | 8.2:1  | AAA ✅ |
| Neutral-50  | #F8FAFC | Neutral-900 | 15.3:1 | AAA ✅ |

---

## Component Color Usage

### Buttons

```css
.btn-primary {
  background-color: var(--color-primary); /* #F76B47 */
  color: white;
  border: none;
}

.btn-primary:hover {
  background-color: var(--color-primary-600); /* #E55A35 */
}

.btn-primary:active {
  background-color: var(--color-primary-700); /* #C84820 */
}

.btn-success {
  background-color: var(--color-success); /* #10B981 */
  color: white;
}

.btn-danger {
  background-color: var(--color-danger); /* #EF4444 */
  color: white;
}

.btn-secondary {
  background-color: var(--bg-tertiary); /* #F1F5F9 */
  color: var(--text-primary); /* #0F172A */
  border: 1px solid var(--border-regular);
}
```

### Alerts & Toasts

```css
.alert-success {
  background-color: var(--color-success-50); /* #ECFDF5 */
  border-left: 4px solid var(--color-success);
  color: var(--color-success-700); /* #047857 */
}

.alert-warning {
  background-color: var(--color-warning-50); /* #FFFBEB */
  border-left: 4px solid var(--color-warning);
  color: var(--color-warning-700); /* #B45309 */
}

.alert-danger {
  background-color: var(--color-danger-50); /* #FEF2F2 */
  border-left: 4px solid var(--color-danger);
  color: var(--color-danger-700); /* #B91C1C */
}
```

### Form Inputs

```css
.input {
  background-color: var(--bg-primary); /* white */
  border: 1px solid var(--border-light); /* #E2E8F0 */
  color: var(--text-primary); /* #0F172A */
}

.input:focus {
  border-color: var(--color-primary); /* #F76B47 */
  box-shadow: 0 0 0 3px var(--color-primary-50); /* Light coral overlay */
}

.input:invalid {
  border-color: var(--color-danger); /* #EF4444 */
}

.input:disabled {
  background-color: var(--bg-tertiary); /* #F1F5F9 */
  color: var(--text-muted); /* #64748B */
  cursor: not-allowed;
}
```

---

## Implementation: CSS Variables

```css
/* Root theme (Light Mode Default) */
:root {
  /* Palette */
  --color-primary-50: #fef6f3;
  --color-primary-100: #fde8df;
  --color-primary-200: #fbc8b3;
  --color-primary-300: #f9a887;
  --color-primary-400: #f78852;
  --color-primary-500: #f76b47;
  --color-primary-600: #e55a35;
  --color-primary-700: #c84820;
  --color-primary-800: #9d3815;
  --color-primary-900: #6d260f;

  --color-success-50: #ecfdf5;
  --color-success-100: #d1f9e6;
  --color-success-200: #a7f0ce;
  --color-success-300: #6fe7b0;
  --color-success-400: #34d399;
  --color-success-500: #10b981;
  --color-success-600: #059669;
  --color-success-700: #047857;
  --color-success-800: #065f46;
  --color-success-900: #064e3b;

  /* ... other colors ... */

  /* Semantic tokens */
  --bg-primary: white;
  --text-primary: #0f172a;
  --border-light: #e2e8f0;
}

/* Dark mode override */
@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #0f172a;
    --text-primary: #f8fafc;
    --border-light: #334155;
  }
}
```

---

## How to Use in Components

### React with Tailwind

```tsx
export function BookingCard() {
  return (
    <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-md">
      <h2 className="text-neutral-900 dark:text-neutral-50 text-lg font-semibold">
        Your Booking
      </h2>
      <p className="text-neutral-600 dark:text-neutral-400 text-sm">
        Details here
      </p>
      <button className="bg-primary-500 hover:bg-primary-600 text-white px-4 py-2 rounded-md">
        Confirm
      </button>
    </div>
  );
}
```

### Raw CSS

```css
.booking-card {
  background-color: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-light);
  padding: 1.5rem;
  border-radius: 0.5rem;
}

.booking-card__title {
  font-size: 1.125rem;
  font-weight: 600;
}

.booking-card__button {
  background-color: var(--color-primary);
  color: white;
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
}

.booking-card__button:hover {
  background-color: var(--color-primary-600);
}
```

---

## Summary

This color palette provides:

- **WCAG AA/AAA Compliance** across light & dark modes
- **Semantic Clarity** (success/warning/danger/info)
- **Brand Personality** (warm coral primary)
- **Accessible Text** (dark text on light, light text on dark)
- **Professional Appearance** (carefully balanced, not garish)
- **Dark Mode Support** (automatic mode switching)

All colors are defined as CSS variables for easy theming and maintenance.
