---
description: Rules for Apollo contact enrichment during cold-email spec generation
globs:
  - "runs/*.spec.mjs"
  - "scripts/**"
alwaysApply: false
---

# Apollo Enrichment Rules

## Stop at 35 verified contacts

When harvesting contacts for a spec, **stop enriching as soon as you reach 35 verified emails on the target domain**. Do not continue burning `bulk_match` or `people/match` credits beyond that number.

- Each spec uses exactly 35 drafts.
- Enriching beyond 35 wastes API credits with no benefit.

## Rate limits (current plan)

| Endpoint | Limit | Reset |
|---|---|---|
| `api/v1/people/bulk_match` | 100 calls / hour | Rolling hourly window |
| `api/v1/people/match` | 50 calls / minute | Rolling per-minute window |

- **`bulk_match`** accepts up to 10 IDs per call. Prefer it when available (up to 1000 enrichments in 100 calls).
- **`people/match`** (single-ID) is a fallback when `bulk_match` is exhausted. Pace at ≥1.3s between calls to stay under 50/min.

## Enrichment loop pattern

```
collected = 0
for each chunk of person IDs:
    enrich chunk via bulk_match (or people/match)
    for each match with email_status === "verified" on target domain:
        add to verified list
        collected++
        if collected >= 35: STOP enriching, break out of all loops
```

## When bulk_match returns a rate-limit error

If `bulk_match` responds with a `message` containing "maximum number of api calls", fall back to `people/match` with 1.3s spacing. If `people/match` also hits its limit, wait for the minute window to reset (60s) or inform the user.
