import {
  type Client,
  createClient,
  createConfig,
} from "./generated/client/index.js";
import * as api from "./generated/sdk.gen.js";
import type * as T from "./generated/types.gen.js";
import {
  ApiConnectionError,
  DegroshiError,
  errorBodyOf,
  errorFor,
} from "./errors.js";
import { type FetchFn, retryingFetch } from "./retry.js";
import { SDK_VERSION } from "./version.js";
import {
  type VerifyOptions,
  type WebhookEvent,
  verifyWebhook,
} from "./webhooks.js";

export interface DegroshiOptions {
  /** A personal access token (dg_pat_…), sent as X-API-Key. Default: the DEGROSHI_API_KEY environment variable. */
  apiKey?: string;
  /** The space to act in (X-Space-ID); optional for a token bound to one space. */
  spaceId?: string;
  /** Default: https://api.degroshi.com */
  baseUrl?: string;
  /** Retries after the first try for requests that are safe to repeat (default 2). */
  maxRetries?: number;
  /** Time for one try until the answer's headers arrive, in ms (default 60 000). */
  timeoutMs?: number;
  /** A fetch to use instead of the global one. */
  fetch?: FetchFn;
}

/** A page of a numbered list: the rows and `meta` (page, per_page, total, has_next…). */
export interface Page<Row> {
  data: Row[];
  meta: T.Meta;
}

type Envelope = { data?: unknown; meta?: unknown };
type Result = { data?: unknown; error?: unknown; response?: Response };
type DataOf<E> = E extends { data: infer D } ? D : never;
type BodyOf<D> = D extends { body: infer B } ? B : never;
type QueryOf<D> = D extends { query?: infer Q } ? NonNullable<Q> : never;

/** Write options: `idempotencyKey` makes a retry safe (one is made for you when you don't pass it). */
export interface WriteOptions {
  idempotencyKey?: string;
}

/**
 * Edit options: `ifMatch` is the row's `version`; the API answers 412 when someone changed it meanwhile. A response
 * without a version (`null`) sends no precondition.
 */
export interface EditOptions {
  ifMatch?: string | number | null;
}

/**
 * Every change since a cursor, page after page (GET /v1/changes), for keeping a copy: `degroshi.changes.iterate()`.
 * `feed.cursor` is where the next read starts; save it after the loop and pass it as `cursor` next time. A cursor that
 * can't continue throws a DegroshiError with status 410 (code CHANGES_RESYNC_REQUIRED): read again without a cursor
 * and replace the copy.
 *
 * ```ts
 * const feed = degroshi.changes.iterate({ cursor: saved, types: ["transaction"] })
 * for await (const change of feed) {
 *   if (change.op === "delete") copy.delete(change.id)
 *   else copy.set(change.id, change.data)
 * }
 * save(feed.cursor)
 * ```
 */
export class ChangeFeed implements AsyncIterable<T.Change> {
  /**
   * Where reading again starts: the start of the page being read, and each page's next_cursor once all of its changes
   * were taken. Stopping early is safe: reading from it again repeats at most the rest of a page (apply by id).
   */
  cursor: string | undefined;
  private readonly read: (
    cursor: string | undefined,
  ) => Promise<T.ChangesResponse>;

  constructor(
    read: (cursor: string | undefined) => Promise<T.ChangesResponse>,
    cursor?: string,
  ) {
    this.read = read;
    this.cursor = cursor;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T.Change> {
    for (;;) {
      const page = await this.read(this.cursor);
      yield* page.items ?? [];
      this.cursor = page.next_cursor;
      if (!page.has_more) return;
    }
  }
}

function readEnv(name: string): string | undefined {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  return env?.[name];
}

/**
 * The Degroshi API client. Amounts are strings, as the API sends them ("642.30"): never parse them into numbers when
 * you add them up.
 *
 * ```ts
 * const degroshi = new Degroshi({ apiKey: process.env.DEGROSHI_API_KEY })
 * for await (const transaction of degroshi.transactions.iterate({ from_date: "2026-11-01" })) { ... }
 * ```
 */
export class Degroshi {
  /** The generated client underneath, for calling the generated functions directly (`client: degroshi.client`). */
  readonly client: Client;

  constructor(options: DegroshiOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("DEGROSHI_API_KEY");
    if (!apiKey)
      throw new Error("degroshi: pass apiKey or set DEGROSHI_API_KEY");
    const headers: Record<string, string> = {
      "X-Degroshi-SDK": `js/${SDK_VERSION}`,
    };
    if (options.spaceId) headers["X-Space-ID"] = options.spaceId;
    this.client = createClient(
      createConfig({
        baseUrl: options.baseUrl ?? "https://api.degroshi.com",
        auth: apiKey,
        headers,
        fetch: retryingFetch(
          options.fetch ?? globalThis.fetch.bind(globalThis),
          {
            maxRetries: options.maxRetries ?? 2,
            timeoutMs: options.timeoutMs ?? 60_000,
          },
        ) as typeof fetch,
      }),
    );
  }

  /** The envelope of a successful call, or the error it failed with. */
  private async envelope(call: Promise<Result>): Promise<Envelope> {
    const result = await call;
    const response = result.response;
    if (response?.ok) return (result.data ?? {}) as Envelope;
    if (!response) {
      throw result.error instanceof Error
        ? result.error
        : new ApiConnectionError(result.error);
    }
    throw errorFor(
      response.status,
      errorBodyOf(response.status, result.error),
      response.headers,
    );
  }

  private async one<R>(call: Promise<Result>): Promise<R> {
    return (await this.envelope(call)).data as R;
  }

  private async page<Row>(call: Promise<Result>): Promise<Page<Row>> {
    const envelope = await this.envelope(call);
    return {
      data: (envelope.data ?? []) as Row[],
      meta: envelope.meta as T.Meta,
    };
  }

  private writeHeaders(options: WriteOptions = {}): Record<string, string> {
    return { "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID() };
  }

  private editHeaders(options: EditOptions = {}): Record<string, string> {
    return options.ifMatch == null
      ? {}
      : { "If-Match": String(options.ifMatch) };
  }

  /** The spaces the token reaches. */
  readonly spaces = {
    list: () =>
      this.one<DataOf<T.MySpaceResponseListEnvelope>>(
        api.listMySpaces({ client: this.client }),
      ),
  };

  readonly accounts = {
    list: (query?: QueryOf<T.ListAccountsData>) =>
      this.one<DataOf<T.AccountListResponseListEnvelope>>(
        api.listAccounts({ client: this.client, query }),
      ),
    get: (id: string) =>
      this.one<DataOf<T.AccountResponseEnvelope>>(
        api.getAccount({ client: this.client, path: { id } }),
      ),
    netWorth: (query?: QueryOf<T.GetAccountsNetWorthData>) =>
      this.one<DataOf<T.NetWorthResponseEnvelope>>(
        api.getAccountsNetWorth({ client: this.client, query }),
      ),
  };

  readonly transactions = {
    /** One page; `meta.has_next` says whether another follows. */
    list: (query?: QueryOf<T.ListTransactionsData>) =>
      this.page<T.TransactionResponse>(
        api.listTransactions({ client: this.client, query }),
      ),
    /** Every matching transaction, page after page. */
    iterate: (query: QueryOf<T.ListTransactionsData> = {}) =>
      this.iterateTransactions(query),
    get: (id: string) =>
      this.one<T.TransactionResponse>(
        api.getTransaction({ client: this.client, path: { id } }),
      ),
    create: (body: BodyOf<T.CreateTransactionData>, options?: WriteOptions) =>
      this.one<T.TransactionResponse>(
        api.createTransaction({
          client: this.client,
          body,
          headers: this.writeHeaders(options),
        }),
      ),
    update: (
      id: string,
      body: BodyOf<T.UpdateTransactionData>,
      options?: EditOptions,
    ) =>
      this.one<T.TransactionResponse>(
        api.updateTransaction({
          client: this.client,
          path: { id },
          body,
          headers: this.editHeaders(options),
        }),
      ),
    delete: (id: string, options?: EditOptions) =>
      this.envelope(
        api.deleteTransaction({
          client: this.client,
          path: { id },
          headers: this.editHeaders(options),
        }),
      ).then(() => undefined),
    dayTotals: (query?: QueryOf<T.GetTransactionDayTotalsData>) =>
      this.one<DataOf<T.DayTotalsResponseEnvelope>>(
        api.getTransactionDayTotals({ client: this.client, query }),
      ),
  };

  readonly categories = {
    list: (query?: QueryOf<T.ListCategoriesData>) =>
      this.one<DataOf<T.CategoryListEnvelope>>(
        api.listCategories({ client: this.client, query }),
      ),
    get: (id: string) =>
      this.one<DataOf<T.CategoryEnvelope>>(
        api.getCategory({ client: this.client, path: { id } }),
      ),
  };

  readonly budgets = {
    list: (query?: QueryOf<T.ListBudgetsData>) =>
      this.one<DataOf<T.BudgetListItemListEnvelope>>(
        api.listBudgets({ client: this.client, query }),
      ),
    get: (id: string) =>
      this.one<DataOf<T.BudgetResponseEnvelope>>(
        api.getBudget({ client: this.client, path: { id } }),
      ),
  };

  readonly recurring = {
    list: (query?: QueryOf<T.ListRecurringTransactionsData>) =>
      this.one<DataOf<T.RecurringResponseListEnvelope>>(
        api.listRecurringTransactions({ client: this.client, query }),
      ),
    get: (id: string) =>
      this.one<DataOf<T.RecurringResponseEnvelope>>(
        api.getRecurringTransaction({ client: this.client, path: { id } }),
      ),
    occurrences: (query?: QueryOf<T.ListRecurringOccurrencesData>) =>
      this.one<DataOf<T.OccurrencesResponseEnvelope>>(
        api.listRecurringOccurrences({ client: this.client, query }),
      ),
  };

  readonly analytics = {
    summary: (query: QueryOf<T.GetAnalyticsSummaryData>) =>
      this.one<DataOf<T.SummaryResponseEnvelope>>(
        api.getAnalyticsSummary({ client: this.client, query }),
      ),
    cashFlow: (query: QueryOf<T.GetAnalyticsCashFlowData>) =>
      this.one<DataOf<T.CashFlowResponseEnvelope>>(
        api.getAnalyticsCashFlow({ client: this.client, query }),
      ),
    categories: (query: QueryOf<T.GetAnalyticsCategoriesData>) =>
      this.one<DataOf<T.CategoryAnalyticsResponseEnvelope>>(
        api.getAnalyticsCategories({ client: this.client, query }),
      ),
    spending: (query: QueryOf<T.GetAnalyticsSpendingData>) =>
      this.one<DataOf<T.SpendingResponseEnvelope>>(
        api.getAnalyticsSpending({ client: this.client, query }),
      ),
    trends: (query: QueryOf<T.GetAnalyticsTrendsData>) =>
      this.one<DataOf<T.TrendsResponseEnvelope>>(
        api.getAnalyticsTrends({ client: this.client, query }),
      ),
    merchants: (query: QueryOf<T.GetAnalyticsMerchantsData>) =>
      this.one<DataOf<T.MerchantAnalyticsResponseEnvelope>>(
        api.getAnalyticsMerchants({ client: this.client, query }),
      ),
    netWorth: (query: QueryOf<T.GetAnalyticsNetWorthData>) =>
      this.one<DataOf<T.NetWorthTimeSeriesResponseEnvelope>>(
        api.getAnalyticsNetWorth({ client: this.client, query }),
      ),
  };

  /** Custom sources: push accounts, transactions and balances from your own system. */
  readonly sources = {
    list: () =>
      this.one<DataOf<T.SourceResponseListEnvelope>>(
        api.listSources({ client: this.client }),
      ),
    get: (id: string) =>
      this.one<DataOf<T.SourceResponseEnvelope>>(
        api.getSource({ client: this.client, path: { id } }),
      ),
    create: (body: BodyOf<T.CreateSourceData>, options?: WriteOptions) =>
      this.one<DataOf<T.SourceResponseEnvelope>>(
        api.createSource({
          client: this.client,
          body,
          headers: this.writeHeaders(options),
        }),
      ),
    update: (id: string, body: BodyOf<T.UpdateSourceData>) =>
      this.one<DataOf<T.SourceResponseEnvelope>>(
        api.updateSource({ client: this.client, path: { id }, body }),
      ),
    delete: (id: string) =>
      this.envelope(
        api.deleteSource({ client: this.client, path: { id } }),
      ).then(() => undefined),
    upsertAccount: (
      id: string,
      externalId: string,
      body: BodyOf<T.UpsertSourceAccountData>,
    ) =>
      this.one<DataOf<T.UpsertAccountResponseEnvelope>>(
        api.upsertSourceAccount({
          client: this.client,
          path: { id, external_id: externalId },
          body,
        }),
      ),
    /** Up to 500 rows; safe to retry (an Idempotency-Key is sent for you). */
    pushTransactions: (
      id: string,
      body: BodyOf<T.PushSourceTransactionsData>,
      options?: WriteOptions,
    ) =>
      this.one<DataOf<T.PushBatchResponseEnvelope>>(
        api.pushSourceTransactions({
          client: this.client,
          path: { id },
          body,
          headers: this.writeHeaders(options),
        }),
      ),
    pushBalances: (
      id: string,
      body: BodyOf<T.PushSourceBalancesData>,
      options?: WriteOptions,
    ) =>
      this.one<DataOf<T.BalanceBatchResponseEnvelope>>(
        api.pushSourceBalances({
          client: this.client,
          path: { id },
          body,
          headers: this.writeHeaders(options),
        }),
      ),
    /** What the space holds from the source, newest first, one page. */
    listPushed: (id: string, query: QueryOf<T.ListSourceTransactionsData>) =>
      this.one<T.PushedPage>(
        api.listSourceTransactions({
          client: this.client,
          path: { id },
          query,
        }),
      ),
    /** Every row the space holds from the source, following next_cursor. */
    iteratePushed: (id: string, query: QueryOf<T.ListSourceTransactionsData>) =>
      this.iteratePushedRows(id, query),
    deletePushed: (id: string, account: string, externalId: string) =>
      this.envelope(
        api.deleteSourceTransaction({
          client: this.client,
          path: { id, account, external_id: externalId },
        }),
      ).then(() => undefined),
  };

  /** What changed in the space since a cursor, deletions included, in the order the changes were saved. */
  readonly changes = {
    /** One page: `items`, `next_cursor` (keep it, even when `items` is empty) and `has_more`. */
    list: (query?: QueryOf<T.ListChangesData>) =>
      this.one<T.ChangesResponse>(
        api.listChanges({ client: this.client, query }),
      ),
    /** Every change since `cursor` (every object first without one); `feed.cursor` is where to start next time. */
    iterate: (query: QueryOf<T.ListChangesData> = {}) =>
      new ChangeFeed(
        (cursor) => this.changes.list({ ...query, cursor }),
        query.cursor,
      ),
  };

  /** The space's events of the last 30 days, as webhook endpoints receive them. */
  readonly events = {
    list: (query?: QueryOf<T.ListEventsData>) => this.eventPage(query),
    iterate: (query: QueryOf<T.ListEventsData> = {}) =>
      this.iterateEvents(query),
    get: (id: string) =>
      this.one<WebhookEvent>(
        api.getEvent({ client: this.client, path: { id } }),
      ),
  };

  /**
   * Webhook endpoints of the space (a token with `webhooks:manage`, for event types its scopes read), and signatures:
   * `await degroshi.webhooks.verify(rawBody, request.headers.get("Degroshi-Signature"), secret)`.
   */
  readonly webhooks = {
    /** The event types an endpoint can take, with a made-up sample of each. */
    eventTypes: () =>
      this.one<DataOf<T.CatalogEntryListEnvelope>>(
        api.listWebhookEventTypes({ client: this.client }),
      ),
    list: () =>
      this.one<DataOf<T.EndpointResponseListEnvelope>>(
        api.listWebhooks({ client: this.client }),
      ),
    get: (id: string) =>
      this.one<DataOf<T.EndpointResponseEnvelope>>(
        api.getWebhook({ client: this.client, path: { id } }),
      ),
    /**
     * A new endpoint in the space; the answer carries its signing secret, which a token can't read back. Not retried:
     * a second try could make a second endpoint.
     */
    create: (body: BodyOf<T.CreateWebhookData>) =>
      this.one<DataOf<T.CreatedEndpointResponseEnvelope>>(
        api.createWebhook({ client: this.client, body }),
      ),
    update: (id: string, body: BodyOf<T.UpdateWebhookData>) =>
      this.one<DataOf<T.EndpointResponseEnvelope>>(
        api.updateWebhook({ client: this.client, path: { id }, body }),
      ),
    delete: (id: string) =>
      this.envelope(
        api.deleteWebhook({ client: this.client, path: { id } }),
      ).then(() => undefined),
    pause: (id: string) =>
      this.one<DataOf<T.EndpointResponseEnvelope>>(
        api.pauseWebhook({ client: this.client, path: { id } }),
      ),
    resume: (id: string) =>
      this.one<DataOf<T.EndpointResponseEnvelope>>(
        api.resumeWebhook({ client: this.client, path: { id } }),
      ),
    /** A new secret; the old one keeps signing for `overlap_hours` (0, 1, 24 or 72). */
    rotateSecret: (id: string, body: BodyOf<T.RotateWebhookSecretData>) =>
      this.one<DataOf<T.SecretResponseEnvelope>>(
        api.rotateWebhookSecret({ client: this.client, path: { id }, body }),
      ),
    /** A made-up event (`webhook.test` without a type), marked `test: true`. */
    sendTest: (id: string, body: BodyOf<T.SendWebhookTestData> = {}) =>
      this.one<DataOf<T.DeliverySummaryEnvelope>>(
        api.sendWebhookTest({ client: this.client, path: { id }, body }),
      ),
    stats: (id: string, query?: QueryOf<T.GetWebhookStatsData>) =>
      this.one<DataOf<T.StatsResponseEnvelope>>(
        api.getWebhookStats({ client: this.client, path: { id }, query }),
      ),
    /** One page of the endpoint's log, newest first: `data` and `meta.next_cursor`. */
    deliveries: (id: string, query?: QueryOf<T.ListWebhookDeliveriesData>) =>
      this.deliveryPage(id, query),
    /** Every delivery of the log, following `meta.next_cursor`. */
    iterateDeliveries: (
      id: string,
      query: QueryOf<T.ListWebhookDeliveriesData> = {},
    ) => this.iterateDeliveryRows(id, query),
    delivery: (id: string, deliveryId: string) =>
      this.one<DataOf<T.DeliveryDetailEnvelope>>(
        api.getWebhookDelivery({
          client: this.client,
          path: { id, delivery_id: deliveryId },
        }),
      ),
    resendDelivery: (id: string, deliveryId: string) =>
      this.one<DataOf<T.DeliverySummaryEnvelope>>(
        api.resendWebhookDelivery({
          client: this.client,
          path: { id, delivery_id: deliveryId },
        }),
      ),
    /** The failed and skipped deliveries between `from` and `to`, again (at most 30 days). */
    resend: (id: string, body: BodyOf<T.ResendWebhookDeliveriesData>) =>
      this.one<DataOf<T.ResendRangeResponseEnvelope>>(
        api.resendWebhookDeliveries({
          client: this.client,
          path: { id },
          body,
        }),
      ),
    verify: (
      rawBody: string | Uint8Array | ArrayBuffer,
      header: string | null | undefined,
      secret: string,
      options?: VerifyOptions,
    ) => verifyWebhook(rawBody, header, secret, options),
  };

  private async *iterateTransactions(
    query: QueryOf<T.ListTransactionsData>,
  ): AsyncGenerator<T.TransactionResponse> {
    for (let page = query.page ?? 1; ; page++) {
      const result = await this.transactions.list({
        ...query,
        page,
        per_page: query.per_page ?? 100,
      });
      yield* result.data;
      if (!result.meta?.has_next || result.data.length === 0) return;
    }
  }

  private async eventPage(
    query?: QueryOf<T.ListEventsData>,
  ): Promise<{ data: WebhookEvent[]; meta: { has_more: boolean } }> {
    const envelope = await this.envelope(
      api.listEvents({ client: this.client, query }),
    );
    return {
      data: (envelope.data ?? []) as WebhookEvent[],
      meta: {
        has_more: Boolean(
          (envelope.meta as { has_more?: boolean } | undefined)?.has_more,
        ),
      },
    };
  }

  private async *iterateEvents(
    query: QueryOf<T.ListEventsData>,
  ): AsyncGenerator<WebhookEvent> {
    let cursor = query.starting_after;
    for (;;) {
      const result = await this.eventPage({ ...query, starting_after: cursor });
      yield* result.data;
      const last = result.data.at(-1);
      if (!result.meta.has_more || !last) return;
      cursor = last.id;
    }
  }

  private async deliveryPage(
    id: string,
    query?: QueryOf<T.ListWebhookDeliveriesData>,
  ): Promise<{ data: T.DeliverySummary[]; meta: T.DeliveryCursorMeta }> {
    const envelope = await this.envelope(
      api.listWebhookDeliveries({ client: this.client, path: { id }, query }),
    );
    return {
      data: (envelope.data ?? []) as T.DeliverySummary[],
      meta: (envelope.meta ?? { has_more: false }) as T.DeliveryCursorMeta,
    };
  }

  private async *iterateDeliveryRows(
    id: string,
    query: QueryOf<T.ListWebhookDeliveriesData>,
  ): AsyncGenerator<T.DeliverySummary> {
    let cursor = query.cursor;
    for (;;) {
      const page = await this.deliveryPage(id, { ...query, cursor });
      yield* page.data;
      if (!page.meta.has_more || !page.meta.next_cursor) return;
      cursor = page.meta.next_cursor;
    }
  }

  private async *iteratePushedRows(
    id: string,
    query: QueryOf<T.ListSourceTransactionsData>,
  ): AsyncGenerator<T.PushedRow> {
    let cursor = query.cursor;
    for (;;) {
      const page = await this.sources.listPushed(id, { ...query, cursor });
      yield* page.items ?? [];
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}

export { DegroshiError };
