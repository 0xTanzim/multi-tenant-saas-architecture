# Design System & UI Patterns

Design tokens, color palette, and component patterns ensuring visual consistency and accessibility.

## Files

### 1. **DESIGN_TOKENS.md**

Complete design token system.

- Spacing scale (4px base grid)
- Typography system
- Shadow depths
- Transitions and animations
- Responsive breakpoints

### 2. **COLOR_PALETTE.md**

Color system with semantic colors.

- Primary, secondary, tertiary colors
- Semantic colors (success, error, warning, info)
- Dark mode color mappings
- Contrast validation (WCAG AA)

## Design System Principles

- **Token-Driven**: All colors/spacing from design tokens (no hardcoded hex)
- **Responsive**: Tokens scale across mobile/tablet/desktop
- **Accessible**: WCAG AA contrast ratios on all colors
- **Consistent**: Same tokens across web, PWA, and Capacitor
- **Dark Mode**: Full dark theme support built-in

## WCAG AA Compliance

- Text contrast: 4.5:1 (normal) / 3:1 (large)
- Component contrast: 3:1
- Color not sole differentiator (+ icons/text for status)

## Reading Order

1. **Designers**: Start with COLOR_PALETTE.md
2. **Frontend Devs**: Read DESIGN_TOKENS.md for implementation
3. **All**: Follow token system (never use hardcoded colors)

## Token Usage

```typescript
// ✅ CORRECT
className={cn("text-foreground bg-card rounded-lg")}

// ❌ WRONG
className="text-black bg-white rounded-[8px]"
```

---

**Key Rule**: Every color, spacing, radius, shadow comes from design tokens.
