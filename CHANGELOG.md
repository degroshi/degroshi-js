# Changelog

Versions follow semver; the major version follows the API's (v1). The API part of each entry comes from comparing the
public spec with the last release (oasdiff); the SDK part lists SDK-only changes.

## 1.0.0-beta.1 (2026-11-13)

### API

- `GET /v1/transactions` takes the new optional filters `types`, `statuses`, `category_ids` and
  `treatment_classes`.
- `GET /v1/transactions/day-totals` takes the new optional filters `types`, `statuses` and `category_ids`.

### SDK

- `require("degroshi")` works on Node 20.19+ and 22.12+: the package exports a `default` condition next to
  `import`. It stays an ES module.

## 1.0.0-beta.0 (2026-11-12)

### API

- Every operation and webhook of the public API v1: accounts, transactions, categories, budgets, recurring
  payments, analytics, custom sources and events.

### SDK

- `new Degroshi({ apiKey })` with resource methods, typed errors, retries with backoff for requests that are safe to
  repeat, an `Idempotency-Key` on creates, page and cursor iterators, and `webhooks.verify`.
