# Contributing

Issues are welcome: bug reports, questions and ideas.

## Reporting a bug

Tell us the SDK version (`SDK_VERSION`), your runtime and its version (Node, Bun, Deno or the browser), what you called and what happened. If the API answered with an error, include its `code` and
`correlation_id`: they let us find the request. Never paste an API key, a webhook secret or real financial data.

## Pull requests

This SDK is generated from the Degroshi public API spec and released from our main repository, so pull requests here
aren't merged directly. When a change is useful, a maintainer ports it into our repository, credits you in the commit
and in the CHANGELOG, and it arrives in the next release. Please open an issue before you start on anything large, so
we can agree on the approach first.

Code in `src/generated` comes from the spec: a change there belongs in the spec, so describe it in an issue.

## Working on the code

```sh
bun install
bun run typecheck
bun run build
bun run test
```
