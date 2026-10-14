---
name: implement_connector_yandex_id
description: Use when handling connector=yandex-id with action=connect or action=disconnect.
---

# Implement Yandex ID Connector

Implement or remove Yandex ID OAuth without changing unrelated product behavior. Follow this contract even when a library offers a shorter default flow.

## Caller contract

The caller context must contain:

```text
connector id: yandex-id
connector action: connect | disconnect
callback path: <same-origin absolute path>
environment variables:
  - client_id: <environment variable name>
  - client_secret: <environment variable name>
```

Validate the connector id, action, callback path, and both role-to-environment-variable mappings before editing. The callback path and environment-variable names come only from this caller contract; do not replace them with provider-specific defaults.

If a required public input is absent or malformed, stop and report its name. Never ask the user to paste a credential into chat. If a credential value unexpectedly appears in context, do not repeat, use, log, or save it; stop before editing and report that it must be replaced through the protected connector UI.

## Mandatory implementation references

Before editing `connect` behavior, read the current official Markdown documentation for the web Authorization Code flow:

- [Receiving a confirmation code from the redirect URL](https://yandex.ru/dev/id/doc/ru/codes/code-url.md) for the authorization request, callback parameters, PKCE, and token exchange;
- [Exchanging the token for user information](https://yandex.ru/dev/id/doc/ru/user-information.md) for the profile request and its provider-specific authorization scheme.

[Requesting an OAuth token with a confirmation code](https://yandex.ru/dev/id/doc/ru/codes/code-and-token.md) is an optional overview. Do not use the console-oriented [`screen-code`](https://yandex.ru/dev/id/doc/ru/codes/screen-code.md) or device-oriented [`screen-code-oauth`](https://yandex.ru/dev/id/doc/ru/codes/screen-code-oauth.md) flows for a VibeCraft web application. If the documentation is temporarily unavailable, follow the pinned contract below instead of substituting generic OAuth conventions.

## Security invariants

- Read credentials only from the two server-side environment variables supplied for the `client_id` and `client_secret` roles. Never add a `NEXT_PUBLIC_` equivalent or a real value to source, `.env.docker`, examples, commands, tests, or documentation.
- Keep the client secret, authorization code, PKCE verifier, provider access/refresh tokens, cookies, and application session identifiers out of browser bundles, HTML, URLs after the callback redirect, client-readable storage, client logs, server logs, traces, screenshots, and test artifacts.
- Implement the callback as a server-only Next.js Route Handler. It must redirect to a clean same-origin application URL before any page layout renders; the template bridge must never observe OAuth query parameters.
- Build `redirect_uri` on the server from the trusted VibeCraft runtime origin and the supplied callback path. Resolve that origin with the exact proxy-aware contract below; never accept a caller-supplied absolute URL or derive it from `Origin`/`Forwarded`.
- Omit both `scope` and `optional_scope` from the authorization request so Yandex uses the permissions selected by the user in the OAuth application settings. Never hardcode, narrow, or broaden those configured permissions in application code.
- Request the profile from `https://login.yandex.ru/info` with exactly `Authorization: OAuth <access_token>`. Never use `Bearer` or a query parameter for this request. The token endpoint's `"token_type": "bearer"` response does not change the Yandex ID profile endpoint's provider-specific `OAuth` authorization scheme.
- For the Yandex ID connector's OAuth transaction and application session cookies, use exactly these CDE-allowlisted names for every set, read, and clear operation: `__Host-vibecraft-oauth-state`, `__Host-vibecraft-oauth-verifier`, and `__Host-vibecraft-session`. Never introduce aliases, provider-specific alternatives, or a generic `session` cookie for this connector. Do not rename or otherwise change unrelated cookies owned by existing application features.
- Keep every Yandex ID connector cookie compliant with the `__Host-` contract: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain`. Create state, verifier, or session values only after the trusted public runtime origin resolves to HTTPS. Required defensive cleanup may still expire an existing connector cookie when callback validation fails; use the same exact name and attributes plus `Max-Age=0` for every clear operation. An internal HTTP `request.url` behind the trusted CDE ingress does not justify omitting the cookie or weakening `Secure`.
- Put every connector `Set-Cookie`, including cleanup, on the exact `NextResponse` that the route returns. Read incoming cookies from the request cookie store, but do not mutate a detached cookie store and then construct a different response.
- Preserve `app/api/health/route.ts`, `BridgeProvider`, `HandshakeListener`, `Toaster`, existing routes, and unrelated DynamoDB/auth/user behavior.
- Never log request bodies or raw provider responses in auth code. Safe errors may name a missing environment variable or failed stage, never a value. Verify application-level redaction; separately report that inbound callback queries may require redaction in proxy/access-log infrastructure outside this repository.

## `connect` procedure

### 1. Inspect before editing

Identify existing users, sessions, authorization rules, routes, UI entry points, data tables, and tests. Extend the current product instead of replacing it with an authentication demo. Keep routes public unless the product request explicitly requires access control.

### 2. Validate runtime configuration

Create a server-only configuration helper that reads the two supplied environment variables at request time. Reject a missing or empty variable with a safe error that names only the supplied environment variable but never includes its value. Do not make image build or static analysis require runtime credentials.

Validate the supplied callback path before using it: require a string that starts with exactly one `/`, has no query or fragment, and resolves to the same origin when passed to `new URL(callbackPath, runtimeOrigin)`.

Create one server-only `resolveRuntimeOrigin(request)` helper and use it for every connector route. The application runs behind VibeCraft/Yandex Cloud proxies: the framework may expose `request.url` as `http://localhost:8080`, while the proxy supplies the public host. Resolve the origin in this order:

1. If `X-Forwarded-Host` is present, require exactly one valid public host and return `https://<forwarded-host>`.
2. Otherwise, use `Host` only when it is a valid public host and differs from the host in `request.url`; this is the deploy/custom-domain fallback. Return `https://<host>`.
3. Otherwise, parse `request.url` and use its normalized origin only when it is already HTTPS.
4. If none applies, fail closed with the safe error `public origin is not configured`.

For either host header, reject empty or overlong values, whitespace, commas, credentials, path/query/fragment delimiters, malformed ports, `localhost`, loopback addresses, `tunnel`, and other single-label/internal hostnames. Parse the whole value; never split a list or choose its first/last element. If `X-Forwarded-Host` is present but invalid, fail closed instead of falling through to another source. The accepted hostname must be a public FQDN; normalize it with the URL parser before interpolation.

Treat an accepted proxy host as externally HTTPS even when `X-Forwarded-Proto` is `http`: in the supported CDE and Serverless Container paths that header describes the final internal hop after TLS termination. Do not let it downgrade the public origin, and do not scan a comma-separated proto list for a convenient value. `Origin`, `Forwarded`, and client-supplied redirect parameters are never origin sources.

Keep this trust assumption local to the helper and document it in code: it is valid because the VibeCraft/Yandex Cloud ingress overwrites the routing headers before the application. Do not reuse the helper outside that trusted proxy boundary without reevaluating it. Append the validated callback path only after origin resolution, and do all of this before creating state, cookies, or database records. Do not add a connector-specific origin environment variable.

Keep the resolver structurally equivalent to this deliberately small decision tree:

```ts
const forwardedHost = request.headers.get("x-forwarded-host");
if (forwardedHost !== null) {
  const publicHost = parseSinglePublicHost(forwardedHost);
  if (!publicHost) throw publicOriginError();
  return `https://${publicHost}`;
}

const requestUrl = parseCredentialFreeUrl(request.url);
const directHost = parseSinglePublicHost(request.headers.get("host"));
if (requestUrl && directHost && directHost !== requestUrl.host.toLowerCase()) {
  return `https://${directHost}`;
}
if (requestUrl?.protocol === "https:") return requestUrl.origin;
throw publicOriginError();
```

`parseSinglePublicHost` must implement every rejection rule above, validate normalized DNS labels (not merely rely on `new URL()` accepting the input), reject IP literals, and return the normalized host with an optional valid port. Keep it independently unit-testable. Do not replace this decision tree with generic “trust proxy” middleware defaults.

### 3. Start Authorization Code flow

Add a server route such as `/api/auth/yandex/start` that:

1. resolves and validates the runtime origin with the shared proxy-aware helper, then builds the absolute redirect URI from that origin and the supplied callback path;
2. creates a cryptographically random, high-entropy `state`;
3. creates a cryptographically random PKCE `code_verifier` and derives an S256 `code_challenge` with base64url encoding;
4. creates a short-lived DynamoDB OAuth transaction keyed by a hash of state, storing the validated redirect URI and expiry but no raw state or verifier;
5. builds the absolute `https://oauth.yandex.ru/authorize` destination with `response_type=code`, client id, the derived redirect URI, state, challenge, and `code_challenge_method=S256`, omitting both `scope` and `optional_scope` so the OAuth application's configured permissions apply;
6. creates the redirect response and sets `__Host-vibecraft-oauth-state` and `__Host-vibecraft-oauth-verifier` on that exact response with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`, and a narrow lifetime;
7. writes one structured server-side diagnostic log containing only the connector id and resolved redirect URI, then returns the prepared response.

If transaction persistence fails, return an error response without any OAuth `Set-Cookie` headers. Do not set browser cookies before the server-side transaction exists.

Do not weaken `Secure` cookies for the local HTTP smoke-test origin. Exercise the real login through a trusted HTTPS runtime origin or test the route response directly.

### 4. Handle the supplied callback path

The server-only callback must read state and the PKCE verifier only from `__Host-vibecraft-oauth-state` and `__Host-vibecraft-oauth-verifier`. It must:

1. parse the cardinality of state, authorization code, and provider error parameters without trusting their values;
2. require exactly one returned state and validate it against the cookie before trusting provider errors or the authorization code;
3. for missing, duplicated, or mismatched state, clear the transient cookies, reject the callback, and leave any unmatched DynamoDB transaction to expire;
4. for a matching state, resolve the runtime origin with the same proxy-aware helper and derive the callback URI from the supplied path; if origin resolution fails, clear the transient cookies, reject the callback, and leave the transaction to expire; otherwise conditionally transition only an unexpired `pending` DynamoDB OAuth transaction whose stored redirect URI matches it to `consumed`; reject origin mismatch, expiry, replay, or concurrent-loser callbacks when this transition fails;
5. after any matched-state origin/consume attempt, clear the state and verifier cookies on every success or error path;
6. require exactly one of: a single authorization code, or a single provider error; reject missing, duplicated, or mixed code/error parameters before provider access;
7. reject provider errors without creating a user or session;
8. exchange the code server-side at `https://oauth.yandex.ru/token` using the documented `application/x-www-form-urlencoded` fields, the server credentials, and `code_verifier`; do not add `redirect_uri`, which is not part of the documented Yandex token request—the authorization request and the validated OAuth transaction own the redirect binding;
9. validate the token response and request the profile from `https://login.yandex.ru/info` with exactly `Authorization: OAuth <access_token>`, never `Bearer` and never a query parameter;
10. validate the profile and identify the external identity by provider plus the stable Yandex subject;
11. create or update the application user/session atomically, then return a clean same-origin redirect response carrying the session cookie.

The clean destination is a relative application path, but `NextResponse.redirect` must receive an absolute URL built from the already validated public runtime origin, for example `NextResponse.redirect(new URL("/", runtimeOrigin), 302)`. Never pass `"/"`, `"/?auth_error=1"`, or another relative string directly to `NextResponse.redirect`, and never use the internal CDE `request.url` as its base. Set or clear cookies on that response object before returning it. If runtime-origin resolution itself fails, either return a safe non-rendering error response or a bare `NextResponse` with a constant relative `Location` header; do not call `NextResponse.redirect` with a relative string.

Do not auto-link an existing local account using email alone. Preserve roles, account status, and unrelated profile data. Deny a new session for disabled, suspended, or otherwise ineligible accounts according to existing authorization rules. If the current product has no verified account-linking policy, keep the Yandex identity distinct and report the limitation.

### 5. Store the application session server-side

Use the template DynamoDB conventions for user, external identity, and session records. Add schema entries, typed model functions, validation, and migrations as needed.

- Generate a new opaque random application session id after successful login.
- Put only that opaque id in `__Host-vibecraft-session` with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`, and a bounded lifetime. Store only a hash of the id in DynamoDB.
- Read the application session id only from `__Host-vibecraft-session`, and enforce expiry and revocation on every server-side lookup.
- Return only the safe application-user view from a current-session endpoint or server loader. Never return provider tokens or the raw provider profile.
- Discard provider tokens after profile loading when the product does not need later Yandex API calls. If ongoing access is required, keep tokens server-side, minimize their scope, and use an existing approved encryption/key-management facility. Never introduce plaintext token persistence as a fallback.

### 6. Add logout and UI states

Logout must read only `__Host-vibecraft-session`, invalidate the server-side session before clearing that exact cookie, and never fall back to another cookie name. Prefer a state-changing server action or POST route and use the same runtime-origin helper for same-origin validation. Treat the request `Origin` only as a value to compare with the independently resolved runtime origin, never as an origin source. Fail closed before session mutation when runtime-origin resolution fails, the header is malformed/duplicated, or it does not match. If the route permits a missing `Origin`, require an existing equivalent CSRF defense; do not silently treat absence as same-origin.

Add signed-out, loading, and signed-in UI states using existing project components. Preserve the requested product flow and all unrelated pages. Do not expose raw provider fields in the browser.

VibeCraft can render the application inside a cross-origin iframe. Detect this only in client UI with `window.self !== window.top`. While embedded, keep the preview signed out and do not call the current-session endpoint. Render the same login control text, iconography, and styling as in the top-level application, but make its ordinary anchor to the server-side authorization start route open with `target="_blank"` and `rel="noopener noreferrer"`. Use a direct link activated by the user's click, not `window.open`, and never navigate the iframe itself to the provider. OAuth completes in the new top-level tab and the clean callback redirect returns there. Outside an iframe, preserve the normal current-session loading and same-tab login behavior.

### 7. Test and verify

Use the bundled executable regression tests for unchanged asset behavior. Before changing that behavior or a product-specific adapter, add and run a regression test that fails for the change. Use fake credentials and mocked provider responses. If the project has no runnable test command, use the bundled node:test/tsx tests and add the focused script; lint, typecheck, and build do not replace route-level tests. Add focused tests for:

- missing or malformed caller context and runtime env names/values without value disclosure or file changes;
- CDE origin resolution from a singleton public `X-Forwarded-Host` when `request.url` is localhost, `Host` is `tunnel`, and `X-Forwarded-Proto` is `http`;
- Serverless Container origin resolution from its public forwarded host, plus the public `Host` fallback used by deploy/custom-domain ingress when the forwarded host is absent;
- HTTPS `request.url` fallback, derived redirect URI, authorization redirect without `scope` or `optional_scope`, random state, and S256 PKCE;
- start setting only `__Host-vibecraft-oauth-state` and `__Host-vibecraft-oauth-verifier` with the required attributes; callback reading and clearing those exact cookies on every required path; no legacy, provider-specific, or alias cookie names;
- malformed, comma-separated, credential-bearing, local, or internal host candidates failing before OAuth side effects at start and clearing transient cookies on callback;
- an HTTP localhost `request.url` without a valid public proxy host failing closed, while `X-Forwarded-Proto: http` does not downgrade an accepted public host;
- identical origin and redirect-URI resolution in start, callback, logout, and any same-origin validation;
- missing, duplicated, mismatched, expired, replayed, origin-mismatched, and concurrently consumed state;
- provider denial and token/profile failures;
- the profile request using exactly `Authorization: OAuth <access_token>`, never the token response's `Bearer` scheme and never a query parameter;
- successful callback, identity creation/linking policy, opaque session creation, and a concrete clean redirect response whose `Location` is either an absolute URL based on the validated public runtime origin or a constant relative header created without `NextResponse.redirect`;
- every error callback returning a concrete clean response instead of throwing while constructing a relative `NextResponse.redirect`;
- the start route returning no `Set-Cookie` headers when OAuth transaction persistence fails, and every success/error response carrying its own required cookie mutations;
- existing-user collision without unsafe email auto-linking and denial for ineligible accounts;
- current-session anonymous/authenticated responses;
- successful login setting only `__Host-vibecraft-session`; current-session lookup reading that exact cookie; logout revoking the server session before clearing that exact cookie with matching `__Host-` attributes;
- embedded and top-level UI behavior: the iframe skips current-session loading and opens the unchanged login link in a new tab with `noopener noreferrer`, while the top-level application keeps normal session loading and same-tab login;
- logout rejecting unresolved, malformed, missing-without-alternative-CSRF, and cross-origin requests before mutation, then revoking the server session before cookie clearing on success;
- signed-in and signed-out UI while unrelated product behavior remains intact;
- absence of OAuth parameters from rendered pages/bridge events and absence of secrets/tokens in logs or browser storage.

Run and record the focused test command, the required DynamoDB migration when schema changes, `npm run check`, and `npm run build` on the host. Do not mark the connector task complete when no executable OAuth tests ran. Do not save a real authenticated Playwright storage state.

## `disconnect` procedure

Disconnect must work after connector secrets have already been deleted. Never read, recreate, or require either credential.

1. Inventory Yandex-owned routes, UI, env reads/validation, runtime-origin integration, identity mapping, provider fields, dependencies, schema, and tests. Treat a proxy-aware origin helper as shared infrastructure when another feature uses it.
2. Remove Yandex-specific start/callback/profile routes and UI entry points introduced for this connector.
3. Remove connector-specific logout/session code only when it is not shared by local auth or another provider.
4. Remove Yandex env validation and reads. Remove a dependency only after proving no remaining import uses it.
5. Stop reading provider token/identity fields. Remove schema/model fields only when they are exclusively Yandex-owned and removal is nondestructive.
6. Preserve unrelated users, user data, sessions, roles, account rules, custom UI, and later adjacent changes. Do not delete a DynamoDB table or user records merely because schema provisioning no longer references them.
7. If ownership is ambiguous after user customization, make the smallest behavior-preserving change and list the retained ambiguity in the execution result.
8. Add or update tests proving anonymous behavior, absence of Yandex login/broken auth links, and continued operation of unrelated auth and product flows.
9. Run focused tests, `npm run check`, and `npm run build`. Scan executable code for the callback path, Yandex endpoints, env reads, provider UI, the three exact `__Host-vibecraft-*` names, legacy cookie names, and unused dependencies.

The execution result must summarize behavior changed, verification performed, and any safe follow-up. Never include credentials, codes, tokens, cookies, or session identifiers.

## Framework reference

- [NextResponse redirect](https://nextjs.org/docs/app/api-reference/functions/next-response#redirect)
