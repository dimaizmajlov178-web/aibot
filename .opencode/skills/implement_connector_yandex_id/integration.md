# Next.js asset integration

The `.template` suffix keeps unconfigured assets out of the template's TypeScript build and executable routes. Copy only files needed for the current connector task; remove that suffix at the destination. Read/compare existing destinations first. Do not bulk copy over existing auth, schema, components, package metadata, or tests.

## Destination map

| Asset under `assets/nextjs/`                         | Application destination                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `lib/auth/{core,dynamodb,client,server}.ts.template` | Same path without `.template`                                                                                             |
| `routes/start.ts.template`                           | `app/api/auth/yandex/start/route.ts`                                                                                      |
| `routes/callback.ts.template`                        | `app<caller callback path>/route.ts` (e.g. `/api/oauth/yandex/callback-v2` → `app/api/oauth/yandex/callback-v2/route.ts`) |
| `routes/session.ts.template`                         | `app/api/auth/session/route.ts`                                                                                           |
| `routes/logout.ts.template`                          | `app/api/auth/logout/route.ts`                                                                                            |
| `components/yandex-login.tsx.template`               | `components/yandex-login.tsx`                                                                                             |
| `components/ui/skeleton.tsx.template`                | `components/ui/skeleton.tsx`, only if absent; otherwise reuse the existing component                                      |
| `tests/*.test.ts.template`                           | `tests/`, same filenames without `.template`                                                                              |

The server wrapper imports `server-only`; Next.js enforces this boundary. UI imports only `lib/auth/client`, never the server/core/store modules. The asset tests exercise core directly with fake injected dependencies; no credentials, running provider, browser, or database is required.

## Four substitutions

In the copied `lib/auth/server.ts`, replace exactly:

- `__CALLBACK_PATH__` with the caller-supplied path;
- `__CLIENT_ID_ENV__` and `__CLIENT_SECRET_ENV__` with supplied environment-variable names, never values;
- `__AUTH_TABLE_NAME__` with the provisioned table name below.

Keep the reusable tests' fake callback/env names independent of the application wiring. Add a small wiring regression for the actual caller path if adapting route mounting. No placeholder may remain in the runtime wrapper.

## Schema and existing users

For a product without auth, merge an unused table key into `TableName` in `lib/schema.ts`, for example `YANDEX_AUTH: "yandex_auth"`. Merge its schema entry into `TABLE_SCHEMAS`:

```ts
[TableName.YANDEX_AUTH]: {
  name: TableName.YANDEX_AUTH,
  keySchema: [{ AttributeName: "id", KeyType: "HASH" }],
  attributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
},
```

Use that same name in the server wrapper. Preserve all existing schema entries. The existing migration reads `TABLE_SCHEMAS`; run `docker compose exec app npm run db:migrate` after integration. No migration-script rewrite is required.

The table contains `oauth#<state hash>`, `identity#yandex:<subject hash>`, and `session#<session hash>` records. Identity and application user share a record in this fresh-auth adapter. The default never discovers/links local users by email. OAuth/session `expiresAt` is enforced on every relevant operation; automatic expired-record cleanup is not assumed. If supported, configure TTL cleanup separately without relying on it for authorization.

When the product already has users or another auth provider, implement/adapt `AuthStore` against those models and test existing roles, suspended/disabled users, identity collisions, atomic writes and session revocation. The ready fresh-auth adapter is not a replacement for the product's linking/status policy.

## Test command and execution

Merge this additional script into `package.json`, preserving existing scripts:

```json
"test:yandex-auth": "tsx --test tests/yandex-*.test.ts"
```

No install step is needed in the current template (`tsx` and Node types already exist). Use the project's existing runner instead if it already owns OAuth tests, preserving the assertions and running the adapted suite. A renamed test must still be selected by the actual command.

Run focused tests after copying/wiring, before final lint/build. For changes to the shipped behavior, first add/run a failing regression, then fix and rerun. Typecheck and final build must include the copied files. Do not run the maintainer materializer from a generated application; it assumes the clean template layout.

## UI

Mount `YandexLogin` in existing header/navigation. Keep its safe user view, ordinary login anchor and embedded detection; adapt styling/copy to the existing app. Both embedded and top-level login must look the same. Preserve the health/bridge/toaster and existing routes. Reuse the project's Skeleton loading state; copy the bundled Skeleton only if the project has none. Do not add jsdom/testing-library solely for the included client-policy tests. They test session-request and anchor policies, not React mounting; verify rendered integration according to the project's allowed test workflow.
