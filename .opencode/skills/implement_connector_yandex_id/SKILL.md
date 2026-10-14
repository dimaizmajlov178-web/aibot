---
name: implement_connector_yandex_id
description: Use when handling connector=yandex-id with action=connect or action=disconnect.
---

# Implement Yandex ID Connector

Connect Yandex ID by integrating the ready Next.js implementation and executable tests in [assets/nextjs](assets/nextjs). Adapt the existing product at the integration boundaries below. The complete provider/security contract is in [references/contract.md](references/contract.md); consult the relevant section when changing bundled behavior. [evals.md](evals.md) evaluates the skill itself, not a list of new test files to invent for each application.

## Validate caller context before editing

Require `connector id: yandex-id`, `connector action: connect | disconnect`, a same-origin absolute `callback path`, and environment-variable **names** mapped to `client_id` and `client_secret`. The callback must start with one `/` and contain no query, fragment, backslash, or whitespace. Env names must be distinct server-only identifiers. Never infer defaults.

If a public input is missing or malformed, stop before editing and name that field. If context contains a credential value, do not repeat/use/save it; stop and report that it must be replaced through the protected connector UI. Disconnect never reads credential values and must work after secrets are deleted.

## Connect: integrate, then verify

1. Inspect existing auth/users/status rules, `lib/schema.ts`, `lib/db.ts`, routes, UI entry point, and test commands. Preserve the product, health/bridge/toaster, other cookies, and unrelated data. Keep pages public unless the product request asks for access control.
2. Read the current official [web code flow](https://yandex.ru/dev/id/doc/ru/codes/code-url.md) and [profile request](https://yandex.ru/dev/id/doc/ru/user-information.md). If unavailable, use the pinned contract and bundled implementation.
3. Follow [integration.md](integration.md) to copy `.template` files to their specified destinations, removing only the `.template` suffix. Inspect every destination first. When a destination already exists, merge only the connector-owned behavior; never overwrite the file wholesale. Reuse the bundled route tests and client-policy tests. No new test dependency is needed: the template already has `tsx` and Node's test runner.
4. For a new auth subsystem, use the bundled DynamoDB adapter. For existing users/auth, adapt `AuthStore` to existing models and eligibility rules; do not introduce a parallel user system without an explicit product decision. Preserve status, roles and profile data; never link by email alone. Keep provider tokens ephemeral.
5. Fill the four **public** placeholders in `lib/auth/server.ts`: caller callback path, two caller env names, and the merged table name. Place callback `route.ts` at that exact caller path. Keep the other route paths aligned with the UI helpers. Runtime credentials are read at request time only.
6. Merge the single-table schema entry and integrate `YandexLogin` into existing chrome. Existing visual components and copy take precedence; preserve identical login appearance in/out of an iframe. Embedded UI skips session loading and uses an ordinary new-tab link. Reuse the project's Skeleton; copy the supplied primitive only if absent.
7. Run `npm run test:yandex-auth` immediately after integration. Add a failing regression **before changing** a bundled behavior or adapter; run it again after the change. Do not recreate the bundled test suite or add a second runner. Record the first failure and final result. If higher-priority instructions prohibit focused tests, report the verification blocker and do not claim completion.
8. Run the required DynamoDB migration after schema changes, then the project's final check/build commands on the host. Keep focused tests separate from expensive final checks. A caller instruction to run lint/build only at the end does not replace OAuth tests. Respect an explicit caller prohibition; the skill cannot override it.

## What is already implemented and tested

| Files                                                                 | Responsibility                                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/auth/core.ts.template`                                           | Exact proxy origin resolution, runtime config, state/S256, returned-response cookies, callback cleanup, provider exchange, current session and POST logout |
| `lib/auth/dynamodb.ts.template`                                       | Hashed single-use OAuth transactions, distinct Yandex identities, atomic session creation/eligibility check, expiry and revocation                         |
| `lib/auth/server.ts.template`, `routes/*.ts.template`                 | Server-only boundary and small Next.js route adapters; caller-specific values are explicit placeholders                                                    |
| `lib/auth/client.ts.template`, `components/yandex-login.tsx.template` | Session loading and embedded/top-level login behavior; component integrates with existing shadcn UI                                                        |
| `tests/*.test.ts.template`                                            | Real NextResponse regressions, mocked provider/DB boundaries, concurrency, logout and client policy                                                        |

The test bundle covers reusable behavior. Add product-specific adapter/UI regressions where integration changes behavior. Client-policy tests do not substitute for checking the final rendered application; storage-command tests do not prove a real database migration or provider login.

## Security boundaries to preserve

- Exact cookies: `__Host-vibecraft-oauth-state`, `__Host-vibecraft-oauth-verifier`, `__Host-vibecraft-session`; always HttpOnly, Secure, SameSite=Lax, Path=/, no Domain. Every mutation belongs to the returned response.
- Runtime origin comes from the trusted ingress contract. Never use `Origin`/`Forwarded` as its source, hardcode a preview host, or downgrade cookies for local HTTP. Keep the documented ingress trust assumption local to the origin helper.
- Authorization omits `scope` and `optional_scope`. Token exchange uses the verifier and does not add `redirect_uri`; profile authorization is exactly `OAuth <access_token>`.
- Consume only a pending, unexpired transaction bound to the derived callback URI before provider access. No replay, unsafe email linking, or sessions for ineligible users.
- Callback returns a clean, non-rendering response before layout/bridge execution. Secrets, codes, raw state/verifier, tokens, session IDs and raw profiles never enter client storage, logs, or artifacts. The start diagnostic contains only connector id and redirect URI.
- Report inbound callback-query redaction as an external proxy/access-log concern; repository redaction alone does not verify it.

## Disconnect

Inventory ownership first. Remove Yandex routes, UI entry points and env reads; remove session/logout/helper dependencies only when unshared. Preserve other auth, users, data, status/roles and later customizations. Never drop a table or delete user records just because schema provisioning stops referencing it. Retain and report ambiguous/shared code. Update tests to verify anonymous behavior and preserved unrelated auth, then run focused tests and final checks. Remove unused runtime dependencies only after checking remaining imports. See the [full disconnect contract](references/contract.md#disconnect-procedure).

## Result

Report changed behavior, test/migration/check/build results, and safe remaining limitations. Do not mark complete without executable OAuth tests. Never include credentials or live flow identifiers.

## Maintaining these assets

Run `node .opencode/skills/implement_connector_yandex_id/scripts/verify-assets.mjs` from the template root; it materializes the assets in a temporary project and runs tests, typecheck and focused lint. Add `--build` to verify the materialized Next.js application. This is a maintainer command, not a dependency or step to add to a generated application's startup.
