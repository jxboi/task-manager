**GREEN** — Well-tested, isolated code. Agents can change it in a tight test loop.  
**YELLOW** — Mixed coverage or coupled behavior. Agents write characterization tests before changing it.  
**RED** — Sensitive or poorly understood behavior. Changes need a written plan, the blast radius, and Jia’s approval. This also applies to session isolation in `src/app.js` and other Red behavior touched through a Yellow file.  
**GATED** — Red-risk app logic that auto-merges only through the Gated gates in Merge rules; treated as Red until those gates are on.

Unlisted files are Red until a row is added.

| Path | Zone | Why | Current tests or gaps |
| --- | --- | --- | --- |
| `api/session.js`, `api/auth/` | RED | Public entry points for credentials, cookies, session discovery, and demo login. | `demo-login.test.js` asserts disabled 404 without a cookie. `api.integration.js` exercises sign-up, sign-in, sign-out, session, and real demo sessions. |
| `api/todos.js` | GATED | Public route to per-user todo reads and mutations. | `api.integration.js` invokes the exported handler and checks signed-out denial, cross-account isolation, and revision conflicts. |
| `server/auth.js` | RED | Configures Better Auth, session lifetime, cookies, CSRF, and the runtime DB pool. | `api.integration.js` checks revocation, expiry, rate limits, CSRF, and demo sessions; no hosted cookie or proxy check. |
| `server/auth-origins.js` | RED | Determines which deployment origins Better Auth trusts. | `auth-origins.test.js` covers exact Preview hosts, malformed hosts, Production HTTPS, and local HTTP; `api.integration.js` exercises the Preview branch origin. |
| `server/auth-endpoints.js` | RED | Dispatches auth by origin, issues session-bound tokens, and gates demo access. | `demo-login.test.js` covers the disabled short circuit; `api.integration.js` covers live auth, branch origin, and demo flows. |
| `server/demo-login.js` | RED | Reserves a shared identity and creates real sessions in Preview. | `demo-login.test.js` covers the environment gate; `api.integration.js` checks reserved-email collision, session issuance, and attempt limits. |
| `server/http.js` | RED | Shared origin, JSON, CSRF, schema, and cookie handling controls every API handler. | `api.integration.js` covers Origin/JSON/CSRF rejection and schema 503; no dedicated wrapper tests for cookie forwarding or unexpected errors. |
| `server/todo-endpoint.js` | GATED | SQL ownership predicates and revision checks protect every todo operation. | `api.integration.js` covers two users, concurrent writes and claims, and persisted ordering; `client.integration.js` checks stale-tab isolation. |
| `server/todo-input.js` | GATED | Server validation controls which todo fields and transitions can be persisted. | `edit-task.test.js` and `reorder.test.js` cover edit and move validators; `api.integration.js` covers ownership fields, length and tag limits, and reminder transitions. |
| `server/schema-guard.js` | RED | A cached migration check decides whether API requests can reach the database. | `schema-guard.test.js` checks missing migrations and cached success; `api.integration.js` checks 503 and recovery after apply. |
| `server/dev.js` | GATED | Enforces the local auth origin and bridges HTTP requests and session cookies. | No direct test of the localhost listener, request body conversion, or multiple Set-Cookie forwarding. DB suites invoke exported handlers. |
| `db/runner.js`, `db/migrate.js` | RED | Apply SQL through an advisory lock, transactions, and a migration ledger. | `schema-guard.test.js` checks filename validation; `migrations.integration.js` covers concurrent reruns, check-only mode, lock waiting, and rollback. |
| `db/build-migrate.js` | RED | Production applies to the unpooled DB and Preview checks the shared DB. | `build-migrate.test.js` checks apply/check/skip, unknown hosted env, and failure handling with an injected runner; no hosted build test. |
| `db/migrations/` | RED | Defines auth and todo schemas and backfills per-user ordering. | `migrations.integration.js` covers empty replay, rollback, and the position upgrade with legacy inserts; API and client DB suites use the resulting schema. |
| `db/*.integration.js` | RED | Test harnesses create and drop schemas on `TEST_DATABASE_URL`. | `api.integration.js` covers live auth and ownership; `client.integration.js` covers browser-module persistence and stale sessions; `migrations.integration.js` covers the SQL lifecycle. Cleanup and target selection have no separate tests. |
| `src/app.js` | YELLOW | One module coordinates rendering, editing, reorder, notifications, and session events. The session-reset / session-boundary path is Red and always goes to Jia. | `app-session.test.js`, `add-toggle.test.js`, `edit-form.test.js`, `reminder-editor.test.js`, and `reorder-ui.test.js` cover core flows with fakes; native pointer capture and notification delivery remain unverified. |
| `src/auth.js` | RED | Tracks the active account across tabs and drives auth, demo, and session invalidation. | `auth-session.test.js` covers cross-tab session changes; `profile-menu.test.js` covers menu focus and sign-out outcomes with fake fetch. No live browser auth flow. |
| `src/drag.js` | GREEN | Isolated geometry, drop target, keyboard, and scroll calculations. | `drag.test.js` covers no-op drags, both directions, unequal heights, ends, and scroll speed; `reorder-ui.test.js` exercises task handles. |
| `src/picker.js` | GREEN | Pure date/time and calendar calculations with explicit inputs. | `picker.test.js` covers invalid dates, unchanged saved instants, default times, month/year edges, and keyboard day moves. |
| `src/popover.js` | GREEN | Small pure placement calculation. | `popover.test.js` covers placement below, flipping above, equality at both margins, and neither side fitting. |
| `src/reminders.js` | GREEN | Isolated reminder normalization and local-time recurrence rules. | `reminders.test.js` covers legacy records, invalid instants, DST gaps and folds, and date limits; `todos.test.js` checks recurring completion. |
| `src/storage.js` | GATED | Attaches CSRF tokens and discards responses for obsolete sessions. | `storage.test.js` covers request shapes, late responses, and no local persistence; `client.integration.js` checks stale tabs and session expiry against Postgres. |
| `src/sync.js` | GATED | Optimistic writes, revision reconciliation, and session resets protect account data. | `sync.test.js` covers rollback, conflicts, retries, claims, and reset with late replies; `client.integration.js` covers account switches and revision races. |
| `src/tags.js` | GREEN | Pure parsing, normalization, and stable color assignment. | `tags.test.js` covers length and count limits, deduplication, malformed tags, hash goldens, and CSS palette parity. |
| `src/task-input.js` | GREEN | Two pure functions share title and tag rules across add and edit. | `edit-task.test.js` covers validation and unchanged titles with literal hashes; `edit-form.test.js` exercises rejection and save via the sheet. |
| `src/todos.js` | GREEN | Pure todo transforms and ordering calculations shared by UI and server. | `todos.test.js` covers immutability, tags, reminders, and completion; `reorder.test.js` covers dense keys, filtered moves, and stable fallback order; `edit-task.test.js` covers edit and no-op rules. |
| `src/viewport.js` | YELLOW | Keyboard reveal depends on browser viewport events and timing. | `viewport.test.js` covers absent viewport, resize timing, listener teardown, and focus reveal with stubs; no real mobile keyboard check. |
| `index.html` | YELLOW | Markup defines the control IDs, initial visibility, dialog, and focus semantics. | `add-toggle.test.js` and `profile-menu.test.js` check selected attributes; DOM stubs leave native tab order and sheet focus behavior unverified. |
| `styles.css` | YELLOW | Layout, hit targets, and motion rely on browser rendering. | `tags.test.js` and `reminder-editor.test.js` check palette rules and pulse CSS as text; no rendered responsive or reduced-motion checks. |
| `vercel.json` | RED | Selects the deploy build, region, output directory, and migration SQL bundled with API functions. | `build-migrate.test.js` covers the called migration logic; no test verifies deployed artifacts or function bundling. |
| `package.json`, `package-lock.json`, `.gitignore` | RED | Build scripts, pinned auth/DB dependencies, and env-file exclusions affect deployment and secrets. | `build-migrate.test.js` exercises the build hook logic; no direct check of build packaging, lockfile reproducibility, or env ignore rules. |
| `.github/workflows/`, `.github/scripts/` | RED | CI gates, prod rollback authority, secrets | These paths are not in the repo on origin/main yet. |
| `ZONES.md`, `AGENTS.md` | RED | These files define the merge policy and agent rules. A Yellow PR must not be able to loosen its own rules, so changes to them are self-protected and go to Jia. | No tests; review by Jia is the only check. |
| `api/categories.js`, `server/category-endpoint.js`, `server/category-input.js` | GATED | They mirror the todos route, endpoint, and input files: per-user category reads and mutations, ownership predicates, and revision checks. | Isolation and revision tests live in `db/categories.integration.js`. |
| `server/transaction.js` | RED | Sets the transaction isolation that every todo and category read and write depends on. Goes to Jia. | Covered only indirectly by the DB integration suites; no dedicated test. |
| `test/*.test.js` | YELLOW | Unit tests for the source files above. A test file changed with its source takes the strictest tier. A PR that deletes or weakens an assertion for a Gated or Red file goes to Jia. | Each file's coverage is listed in the rows for its source. |
| `README.md` | YELLOW | Local setup, API, and release guidance can drift from code. | No docs checks; `build-migrate.test.js` and `api.integration.js` cover parts of the described behavior. |
| `test/dom.js`, `test/fake-api.js`, `test/markup.js` | YELLOW | Shared stubs stand in for browser semantics and API responses. | `app-session.test.js`, `reorder-ui.test.js`, `profile-menu.test.js`, and `sync.test.js` exercise them indirectly; no harness parity checks. |

## Merge rules

- **Green**: auto-merges with CI plus one CLI review passing.
- **Yellow**: auto-merges at any size when CI, one CLI review, and Playwright's iPhone 14 device (WebKit, 390px) plus desktop Chrome all pass, with screenshots on the PR. Yellow covers `styles.css`, `index.html`, `src/viewport.js`, `README.md`, test helpers, and `src/app.js` except the session-reset path.
- **Gated (new tier)**: `api/todos.js`, `server/todo-endpoint.js`, `server/todo-input.js`, `api/categories.js`, `server/category-endpoint.js`, `server/category-input.js`, `src/sync.js`, `src/storage.js`, `server/dev.js`. These auto-merge only when all of these pass:
  - integration suites on a throwaway Neon branch;
  - two CLI reviews on different models (codex and claude);
  - a no-new-delete-path check (the same check as the data-change rule under "Always goes to Jia": one check, not two);
  - a prod smoke check with automatic rollback.  
  This tier stays OFF, meaning those PRs go to Jia, until DevOps finishes that CI and rollback work. The gates are not currently running.
- **Always goes to Jia**:
  - `db/migrations/`, `db/runner.js`, `db/migrate.js`, `db/build-migrate.js`, `db/*.integration.js`;
  - all auth files (`api/session.js`, `api/auth/`, `server/auth*.js`, `server/demo-login.js`), `server/http.js`, `src/auth.js`, and the `src/app.js` session-reset path;
  - `vercel.json`, `package.json`, the lockfile (`package-lock.json`), `.gitignore`;
  - `.github/workflows/`, `.github/scripts/`;
  - `ZONES.md`, `AGENTS.md`, `server/transaction.js`;
  - any change that deletes or rewrites user data. Concretely, a PR goes to Jia if a non-test file adds or changes any of these:
    - SQL `DELETE`, `TRUNCATE`, or `DROP`;
    - a new DELETE route or method branch;
    - an `UPDATE` whose WHERE clause isn't keyed on `user_id` plus a single row `id`.

    This is the same check as the Gated tier's no-new-delete-path gate (one check, not two);
  - any PR with a failed gate, disagreeing reviewers, or a fired rollback.  
  Red-zone files that were not moved to Gated also still go to Jia (do not loosen them).

### Rules that apply to every PR

- A **one-way door** is hard or impossible to reverse, such as a destructive or data-rewriting migration, deleting or rewriting user data, or an API or contract change clients rely on. Changes that meet the user-data check under "Always goes to Jia" count as one-way doors.
- A **two-way door** is undone by a plain revert or redeploy.
- One-way doors never auto-merge; they go to Jia, whatever the file tiers.
- Every PR description carries a door bullet in its Risk + Blast radius block.
- A PR takes its strictest file's tier.
- Unlisted files are Red until a row is added.
- A test file changed with its source takes the strictest tier. A PR that deletes or weakens an assertion for a Gated or Red file goes to Jia.
- Only the exact reviewed head merges; a new commit needs its gates again.
- Merges are done by DevOps Engineer.

### Oversight

- A daily list of what auto-merged goes to Jia, set up and owned by DevOps.
- A pause switch Jia controls that stops all auto-merges, set up and owned by DevOps.
