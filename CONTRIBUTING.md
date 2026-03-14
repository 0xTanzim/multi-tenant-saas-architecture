# Contributing to This Repository

This is a **reference architecture and portfolio repository**. We welcome feedback, improvements, and corrections.

---

## 📋 What This Repository Is

A comprehensive guide to building **production-grade multi-tenant SaaS systems**. It includes:

- Architectural decisions and patterns
- Real-world code examples
- Best practices and lessons learned
- Interview preparation materials

---

## 🤝 How to Contribute

### Reporting Issues

Found an error, unclear explanation, or broken link?

**Create an issue with:**

1. **Title**: Clear, specific problem
2. **Description**: What's wrong and where
3. **Context**: What were you reading/trying to do?
4. **Suggestion**: What would make it better?

**Example:**

```
Title: Broken link in API Design section
Description: The link to "database-indexing.md" on line 45 of
docs/05-api-design/API_PATTERNS.md returns 404.
Suggestion: Either fix the link or remove the reference.
```

---

### Suggesting Improvements

Have an idea for better explanation, additional examples, or new content?

**Create an issue with:**

1. **Title**: What you're suggesting
2. **Why**: Why would this improve the repository?
3. **Where**: Which section or document?
4. **Details**: Specific improvement or new content idea

**Example:**

```
Title: Add example for tenant isolation in stored procedures
Why: Current examples are all application-layer filtering.
Database-layer enforcement would be valuable for security-conscious readers.
Where: docs/03-authorization-security/
Details: Show a PostgreSQL stored procedure that enforces tenant_id
before returning data.
```

---

### Submitting Content

Want to contribute written content or code examples?

1. **Open an issue first** - Discuss your idea before investing time
2. **Fork the repository** - Clone to your workspace
3. **Create a branch** - Name it descriptively (e.g., `add-redis-caching-guide`)
4. **Write your content** - Follow the style guide below
5. **Self-review** - Check for clarity, links, accuracy
6. **Submit a pull request** - Reference the issue

**PR Title Format**: `docs: add Redis caching guide` or `fix: update API endpoint example`

---

## ✍️ Style Guide

### Documentation Standards

- **Tone**: Professional, clear, not condescending
- **Audience**: Engineers with SaaS experience (don't over-explain fundamentals)
- **Structure**: Heading hierarchy, short paragraphs, examples
- **Code**: TypeScript/NestJS/Drizzle examples preferred
- **Links**: Cross-reference related documents

### Formatting

```markdown
# Main Topic

## Section

### Subsection

- Bullet points for lists
- Code examples in triple backticks
- Links in [text](path) format
- Bold for **emphasis**, not _italics_
```

### Code Examples

```typescript
// Include language identifier
// Comments explain the WHY, not the WHAT
// Keep examples short and focused
// Show good practices consistently

// ✅ Good
const users = db
  .select()
  .from(usersTable)
  .where(eq(usersTable.tenantId, tenantId)); // Tenant filter is explicit

// ❌ Avoid
const users = db.select().from(usersTable); // Missing tenant isolation!
```

### Linking

- **Within repo**: `[Link text](./path/to/file.md)` or `[text](./path/file.md#section)`
- **GitHub**: `[GitHub](https://github.com/yourusername/repo)`
- **External**: Full URL with clear label

---

## 🎯 What We're Looking For

### High Priority

- Clarifications on complex concepts
- Corrections to errors or outdated information
- Missing code examples
- Real-world scenarios or case studies

### Welcome

- Improvements to existing content
- Additional resources and references
- Alternative approaches or perspectives
- Interview prep questions and answers

### Not Looking For

- Off-topic content (this is about multi-tenant SaaS, not other domains)
- Significant rewrites of existing sections (open an issue first)
- Unreviewed code or untested approaches

---

## 🚫 Not Accepting

- Content from other sources without attribution
- Self-promotional content
- Unrelated topics
- Content that contradicts established patterns without clear justification

---

## 📝 Review Process

1. **Issue opened** → Assign to contributor
2. **Discussion** → Clarify scope and approach
3. **Content submitted** → Review for accuracy and fit
4. **Feedback** → Revisions if needed
5. **Merge** → Published to main branch

Review timeline: Usually 3-7 days.

---

## ✅ Quality Checklist

Before submitting, ensure:

- [ ] Content is accurate and verified
- [ ] Examples are tested (if code)
- [ ] Links are correct (no 404s)
- [ ] Follows style guide above
- [ ] Related documents are cross-referenced
- [ ] No typos or formatting issues
- [ ] Adds value to the repository

---

## 📚 Resources

### Related Documentation

- **Core Concepts**: [docs/01-core-concepts/](./docs/01-core-concepts/)
- **Real-World Patterns**: [docs/07-real-world-patterns/](./docs/07-real-world-patterns/)
- **Decision Records**: [docs/10-decision-records/](./docs/10-decision-records/)

### Questions About Contributing?

- **How do I open an issue?** → [GitHub Issues Guide](https://docs.github.com/en/issues)
- **How do I fork/PR?** → [GitHub Pull Request Guide](https://docs.github.com/en/pull-requests)
- **More questions?** → Create a discussion or issue

---

## 🙏 Thank You

Every contribution makes this resource better for the next engineer learning about multi-tenant architecture.

We appreciate your help!

---

## 📋 License

By contributing to this repository, you agree that your contributions are licensed under the MIT License. See [LICENSE](./LICENSE) for details.

---

**Questions? Open an issue and we'll help.**
