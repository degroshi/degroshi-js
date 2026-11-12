# Degroshi for JavaScript and TypeScript

[![npm](https://img.shields.io/npm/v/degroshi)](https://www.npmjs.com/package/degroshi)
[![CI](https://github.com/degroshi/degroshi-js/actions/workflows/ci.yml/badge.svg)](https://github.com/degroshi/degroshi-js/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

The official SDK for the [Degroshi API](https://docs.degroshi.com/en/developers). It has typed methods for accounts,
transactions, categories, budgets, recurring payments, analytics, custom sources and events. Retries are safe to
repeat, and webhook signatures are checked for you. It has no runtime dependencies and runs on Node 20+, Bun, Deno,
browsers and edge runtimes.

## Install

```sh
npm i degroshi
```

## Authenticate

Create a personal access token in Degroshi under "Settings" › "For developers", and keep it on a server: anyone who
reads it can use it. The client takes it as `apiKey`, or reads `DEGROSHI_API_KEY` from the environment.

```ts
import { Degroshi } from "degroshi"

const degroshi = new Degroshi({ apiKey: process.env.DEGROSHI_API_KEY })

const accounts = await degroshi.accounts.list()
```

A token that reaches several spaces needs the space too: `new Degroshi({ apiKey, spaceId })`. The IDs are under
"Settings" › "For developers" › "Space IDs".

## Pagination

`transactions.list()` returns one page: `data` and `meta` (`page`, `per_page`, `total`, `has_next`).
`transactions.iterate()` walks every page for you:

```ts
for await (const transaction of degroshi.transactions.iterate({ from_date: "2026-11-01" })) {
  console.log(transaction.transaction_date, transaction.direction, transaction.amount)
}
```

Lists that use cursors (`sources.iteratePushed`, `events.iterate`) follow `next_cursor` the same way.

## Money

Amounts are strings, exactly as the API sends them (`"642.30"`), so no precision is lost. Don't turn them into
numbers to add them up: use a decimal library or your database. Totals across currencies come from the API's
analytics, already converted.

## Write safely

`transactions.create`, `sources.create`, `sources.pushTransactions` and `sources.pushBalances` send an
`Idempotency-Key`, so a retry after a dropped connection returns the first answer instead of writing twice. Pass your
own key to retry safely across restarts:

```ts
await degroshi.transactions.create(
  { account_id: accountId, amount: "120.00", type: "expense", transaction_date: new Date().toISOString() },
  { idempotencyKey: `order-${orderId}` }
)
```

Edits take the row's `version` as `ifMatch`. If someone changed the row in the meantime, the API answers 412 and the
client throws a `ConflictError`.

## Errors

Every API error is a `DegroshiError` with `status`, `code` (for example `TXN_ACCOUNT_CONNECTED`), `details` and
`correlationId`; include the `correlationId` when you contact support. Subclasses name the common cases:
`BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `ConflictError`,
`UnprocessableEntityError`, `RateLimitError` and `InternalServerError`. A network failure is an `ApiConnectionError`,
and a timeout is an `ApiTimeoutError`.

```ts
import { NotFoundError } from "degroshi"

try {
  await degroshi.accounts.get(accountId)
} catch (error) {
  if (error instanceof NotFoundError) console.log("No such account in this space")
  else throw error
}
```

Requests that are safe to repeat are retried on network failures, 408, 429, 500, 502, 503 and 504, with backoff and
respecting `Retry-After`. `maxRetries` sets how many times (default 2), and `timeoutMs` how long one try may take (default
60 000).

## Webhooks

Check every delivery before you trust it. Pass the raw body, before any JSON parsing:

```ts
import { verifyWebhook } from "degroshi"

const event = await verifyWebhook(rawBody, request.headers.get("Degroshi-Signature"), process.env.WEBHOOK_SECRET!)
if (event.type === "transaction.created") console.log(event.data.object.amount)
```

`verifyWebhook` throws a `WebhookVerificationError` with a `reason` for a wrong signature, a malformed header or a
signature older than five minutes. While you rotate a secret, either secret passes. `degroshi.webhooks.verify` does the
same.

`degroshi.events.iterate()` reads the space's events of the last 30 days, in the same shape as webhook deliveries, so
you can catch up after downtime.

## Documentation

- [Developer guide](https://docs.degroshi.com/en/developers): tokens, spaces, limits and errors.
- [API reference](https://docs.degroshi.com/en/developers/api/me/list-my-spaces): every endpoint and its fields.
- [Webhooks](https://docs.degroshi.com/en/developers/webhooks): events, signatures and retries.

## Versions

The SDK follows semver, and its major version follows the API's (v1). A minor release adds operations or fields, and
a patch release fixes the SDK. Breaking changes come only with a new major version. See [CHANGELOG.md](CHANGELOG.md).

## Contributing and security

Issues are welcome. The SDK is generated from the public API spec, so pull requests aren't merged here directly: see
[CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability privately, as [SECURITY.md](SECURITY.md) explains.

## Licence

Apache-2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). The Degroshi name and logo aren't licensed.
