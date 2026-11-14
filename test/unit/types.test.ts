import { describe, expect, it } from "bun:test";
import type { Degroshi } from "../../src/index.js";
import type * as T from "../../src/generated/types.gen.js";

/*
 * Every method of every resource returns a named type, never `unknown`: these checks run in `tsc --noEmit` (the
 * sdks check), so a method that falls back to `unknown` breaks the build instead of reaching a release.
 */

/** The resource namespaces (`degroshi.accounts`, …); `client` is the generated client underneath. */
type Resource = {
  [K in Exclude<keyof Degroshi, "client">]: Degroshi[K] extends Record<string, (...args: never[]) => unknown> ? K : never;
}[Exclude<keyof Degroshi, "client">];

type Result<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

/** "resource.method" for each method whose result is `unknown`; `never` when there is none. */
type UnknownResults = {
  [R in Resource]: {
    [M in keyof Degroshi[R]]: unknown extends Result<Degroshi[R][M]> ? `${R}.${M & string}` : never;
  }[keyof Degroshi[R]];
}[Resource];

type Is<Actual, Expected> = [Actual] extends [Expected] ? ([Expected] extends [Actual] ? true : false) : false;

const noUnknownResults: Is<UnknownResults, never> = true;
const recurringList: Is<Result<Degroshi["recurring"]["list"]>, T.RecurringResponse[]> = true;
const recurringGet: Is<Result<Degroshi["recurring"]["get"]>, T.RecurringResponse> = true;
const summary: Is<Result<Degroshi["analytics"]["summary"]>, T.SummaryResponse> = true;
const spending: Is<Result<Degroshi["analytics"]["spending"]>, T.SpendingResponse> = true;
const trends: Is<Result<Degroshi["analytics"]["trends"]>, T.TrendsResponse> = true;
const sourcesList: Is<Result<Degroshi["sources"]["list"]>, T.SourceResponse[]> = true;
const sourceCreate: Is<Result<Degroshi["sources"]["create"]>, T.SourceResponse> = true;
const upsertAccount: Is<Result<Degroshi["sources"]["upsertAccount"]>, T.UpsertAccountResponse> = true;

describe("result types", () => {
  it("names a type for every method (checked by tsc)", () => {
    expect([
      noUnknownResults,
      recurringList,
      recurringGet,
      summary,
      spending,
      trends,
      sourcesList,
      sourceCreate,
      upsertAccount,
    ]).not.toContain(false);
  });
});
