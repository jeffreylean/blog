# Bookmark Page — Implementation Spec

**Status:** Ready for task breakdown
**Effort:** L (1-2 days)
**Date:** 2026-03-29

## Problem Statement

**Who:** Jeffrey (blog author)
**What:** Saves interesting articles/videos as open browser tabs on mobile. No searchable, tagged, persistent collection. Tabs get lost.
**Why it matters:** Valuable reading list scattered across ephemeral browser tabs with no organization or retrieval.

## Proposed Solution

A bookmark system with three components:

1. **Cloudflare Worker + D1** — CRUD API for bookmarks. Accepts URLs from mobile, auto-fetches page title, stores in D1. Serves bookmark data to the public page.
2. **Hugo static page** — `/bookmarks/` page with client-side JS that fetches from the Worker API. Tag filtering, search. Read/unread status hidden from visitors.
3. **Rust CLI** — `bookmark` binary for managing bookmarks. Export/import JSON pattern for LLM-agnostic agent auto-tagging workflow.

**Capture flow:** Android Share Sheet → HTTP Shortcuts app → POST URL to Worker → D1.
**Curation flow:** CLI exports untagged bookmarks as JSON → external agent reads URLs, generates tags/notes → CLI imports results back.

## Scope & Deliverables

| # | Deliverable | Effort | Depends On |
|---|-------------|--------|------------|
| D1 | D1 schema + Worker API | M | - |
| D2 | Hugo bookmarks page (frontend) | M | D1 |
| D3 | Rust CLI (`bookmark` binary) | M | D1 |
| D4 | Config.toml menu entry + deploy | S | D1, D2 |
| D5 | Android HTTP Shortcuts setup (docs) | S | D1 |

## Non-Goals

- No admin web UI — curation happens via CLI + agent
- No SSR/SEO optimization — page is client-side rendered
- No bookmark import from browser/Pocket/etc
- No user accounts — single-user system
- CLI does not embed any LLM — agent orchestration is external

## Data Model

### D1 Schema

```sql
CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    note TEXT,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_approved INTEGER DEFAULT 1
);

CREATE TABLE bookmark_tags (
    bookmark_id INTEGER REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (bookmark_id, tag_id)
);
```

### Seed Tags (14 approved)

```
distributed-systems, networking, systems-programming, databases,
web, devtools, security, performance, career, architecture,
cloud, observability, ai, agent
```

## API Contract

**Base URL:** `https://bookmarks.leanwf1117.workers.dev`

**Auth:** API key via `Authorization: Bearer <key>` header on all write endpoints. Read endpoints are public.

### Endpoints

#### `POST /bookmarks`
Create a bookmark. Worker auto-fetches `<title>` from URL.

```
Request:  { "url": "https://example.com/article" }
Response: { "id": 1, "url": "...", "title": "Auto-fetched Title", "created_at": "..." }
```

#### `GET /bookmarks`
List bookmarks (public). Supports query params for filtering.

```
Query params:
  ?tag=rust           — filter by tag
  ?search=consensus   — search title + note
  ?untagged=true      — only untagged (for CLI export)
  ?unread=true        — only unread
  ?limit=50&offset=0  — pagination

Response: {
  "bookmarks": [
    {
      "id": 1,
      "url": "...",
      "title": "...",
      "note": "...",
      "is_read": false,     // included but frontend hides it
      "tags": ["rust", "systems-programming"],
      "created_at": "...",
      "updated_at": "..."
    }
  ],
  "total": 42
}
```

#### `PATCH /bookmarks/:id` (auth required)
Update bookmark fields.

```
Request:  { "tags": ["rust", "networking"], "note": "Great raft explanation", "is_read": true }
Response: { "id": 1, "url": "...", ... }  // updated bookmark
```

#### `DELETE /bookmarks/:id` (auth required)
Delete a bookmark.

#### `GET /tags`
List all tags.

```
Response: {
  "approved": ["rust", "networking", ...],
  "pending": ["new-tag-1", ...]
}
```

#### `POST /tags/approve` (auth required)
Approve a pending tag.

```
Request:  { "name": "new-tag" }
```

#### `POST /tags` (auth required)
Add a new approved tag.

```
Request:  { "name": "new-tag" }
```

#### `POST /bookmarks/batch` (auth required)
Batch update bookmarks (for CLI import).

```
Request: {
  "updates": [
    { "id": 1, "tags": ["rust"], "note": "..." },
    { "id": 2, "tags": ["web"], "note": "...", "is_read": true }
  ]
}
Response: { "updated": 2 }
```

### CORS

Allow origins: `https://jeffrey-lean.com`, `http://localhost:*`

### Error Responses

```
401: { "error": "Unauthorized" }
404: { "error": "Bookmark not found" }
409: { "error": "URL already bookmarked" }
422: { "error": "Invalid URL" }
```

## CLI Interface (`bookmark`)

Rust binary. Config stored in `~/.config/bookmark/config.toml`:

```toml
api_url = "https://bookmark-api.<subdomain>.workers.dev"
api_key = "your-secret-key"
```

### Subcommands

```
bookmark list                          # list all bookmarks
bookmark list --untagged               # only untagged
bookmark list --unread                 # only unread
bookmark list --tag rust               # filter by tag

bookmark add <url>                     # manually add a bookmark

bookmark update <id> --tags "rust,systems-programming"
bookmark update <id> --note "great article"
bookmark update <id> --read

bookmark tags                          # list approved + pending tags
bookmark tags approve <tag>            # approve a pending tag
bookmark tags add <tag>                # add new approved tag

bookmark export --untagged --json      # dump untagged as JSON (for agent)
bookmark import <file.json>            # batch update from JSON (from agent)
```

### Export/Import JSON Format

**Export** (`bookmark export --untagged --json`):
```json
[
  { "id": 1, "url": "https://...", "title": "...", "created_at": "..." },
  { "id": 2, "url": "https://...", "title": "...", "created_at": "..." }
]
```

**Import** (`bookmark import tagged.json`):
```json
[
  { "id": 1, "tags": ["rust", "networking"], "note": "Raft consensus deep dive" },
  { "id": 2, "tags": ["career"], "note": "Good advice on IC vs manager track" }
]
```

Tags not in the approved list are created as `is_approved = 0` (pending).

## Hugo Page

### File: `content/bookmarks/_index.md`

```yaml
---
title: "Bookmarks"
layout: "bookmarks"
---
```

### Layout: `layouts/bookmarks/list.html`

- Inherits from theme's `baseof.html` via `{{ define "main" }}`
- Renders a shell with:
  - Tag filter chips (fetched from `/tags` endpoint)
  - Search input
  - Bookmark list container
- Inline `<script>` fetches from Worker API (same pattern as view counter)
- Worker URL from `site.Params.bookmarkApiUrl`
- Each bookmark renders: title (linked), tags (chips), note, date
- Read/unread status NOT rendered

### Config.toml Addition

```toml
[[menu.main]]
  pageRef = "bookmarks"
  name = 'Bookmarks'
  url = '/bookmarks/'
  weight = 25
```

```toml
[params]
  bookmarkApiUrl = "https://bookmarks.leanwf1117.workers.dev"
```

## Acceptance Criteria

- [ ] `POST /bookmarks` with a URL saves it to D1 and auto-fetches title
- [ ] `GET /bookmarks` returns paginated, filterable bookmark list
- [ ] `PATCH /bookmarks/:id` updates tags, note, read status (auth required)
- [ ] `POST /bookmarks/batch` processes bulk updates from CLI import
- [ ] Write endpoints reject requests without valid API key
- [ ] `/bookmarks/` page loads, displays bookmarks, filters by tag, searches by text
- [ ] Read/unread status is NOT visible on the public page
- [ ] `bookmark export --untagged --json` outputs correct JSON
- [ ] `bookmark import <file>` sends batch update to API
- [ ] Unapproved tags created via import are marked `is_approved = 0`
- [ ] `bookmark tags approve <tag>` flips `is_approved` to 1
- [ ] Android HTTP Shortcuts can POST a URL and receive success response

## Test Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | D1 query logic, URL validation, title fetching | Worker tests (vitest or miniflare) |
| Unit | CLI arg parsing, JSON serialization | Rust unit tests |
| Integration | Full API CRUD flow | `wrangler dev` + curl/httpie |
| E2E | Mobile capture → page display | Manual: share URL from Android, verify on page |

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Title fetch fails (timeout, blocked) | Medium | Low | Store bookmark anyway with URL as fallback title. Retry title fetch on next GET. |
| D1 free tier limits (5M reads/day, 100K writes/day) | Low | Medium | Way beyond personal usage. Monitor if sharing publicly drives unexpected traffic. |
| API key leaked in HTTP Shortcuts | Low | Medium | Key only grants bookmark write. Rotate via `wrangler secret put`. |
| Agent generates bad tags at scale | Medium | Low | Pending tag system quarantines new tags. Periodic `bookmark tags` review. |

## Trade-offs Made

| Chose | Over | Because |
|-------|------|---------|
| D1 (SQLite) | KV | Need relational queries: tag filtering, search, joins |
| Client-side rendering | Static Hugo build from D1 | Bookmarks update frequently; no rebuild needed. SEO irrelevant for personal page. |
| Separate Worker | Extending view-counter Worker | Separation of concerns. Different storage (D1 vs KV). Independent deploy. |
| API key auth | Cloudflare Access | Single user, low risk. Simpler mobile integration. |
| Export/import JSON | Embedded LLM in CLI | LLM-agnostic. Agent decides model/provider. CLI stays simple. |
| Rust CLI | Go / shell script | User preference. Single binary distribution. |

## Resolved Questions

- [x] Worker name: `bookmarks` → `https://bookmarks.leanwf1117.workers.dev`
- [x] Page styling: match `hugo-blog-awesome` theme — reuse existing CSS classes (`.post-item`, etc.), add minimal custom CSS for tag chips and search bar only

---
*Spec approved for task decomposition.*
