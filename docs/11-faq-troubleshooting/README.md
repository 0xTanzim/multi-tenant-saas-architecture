# FAQ & Troubleshooting

Common questions, gotchas, and troubleshooting procedures.

## 3 Key Categories

### 1. **FAQ.md**

Frequently asked questions about the system.

- Common setup questions
- Architecture clarifications
- Implementation decisions
- Performance questions

### 2. **TROUBLESHOOTING_GUIDE.md**

Common issues and solutions.

- Tenant isolation bugs
- Performance problems
- Database connection issues
- Cache invalidation problems

### 3. **GOTCHAS_AND_PITFALLS.md**

Common mistakes and how to avoid them.

- Forgetting tenant_id in queries
- Cache key collisions
- Token expiration handling
- Cross-tenant data leakage

## Common Questions

- How do I add a new feature that affects multiple tenants?
- Why is my query running slow?
- How do I test tenant isolation?
- Can I query across tenants?
- How do I handle deleted data?

## Troubleshooting by Symptom

| Symptom                        | Likely Cause                   | Solution                       |
| ------------------------------ | ------------------------------ | ------------------------------ |
| Seeing data from other tenants | Missing tenant_id filter       | See TROUBLESHOOTING_GUIDE.md   |
| Slow API responses             | N+1 queries or missing indexes | See ../06-caching-performance/ |
| Cache not updating             | Invalidation not triggered     | See TROUBLESHOOTING_GUIDE.md   |
| Auth failures                  | Invalid tenant context         | Check GOTCHAS_AND_PITFALLS.md  |

---

**Need help?** Start with FAQ.md, then check TROUBLESHOOTING_GUIDE.md, then GOTCHAS_AND_PITFALLS.md
