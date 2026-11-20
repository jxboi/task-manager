# task-manager

A small todo list app. Sign in, then add a task, tick it off, delete it.
Each account's tasks are saved on the server, so they follow you to any browser you sign in from, and two accounts on the same device never see each other's lists. Signed out, no tasks are shown or kept in the browser.
Type `#tags` in a new task (`Pay rent #home`) to tag it; each tag gets a fixed color from its name, and the tag chips filter the list (any selected tag matches).
Give a task a reminder ("+ reminder": a date and time, repeating daily or weekly if you like). Overdue tasks are marked and listed first.
Checking a repeating task keeps it checked until the start of the next scheduled occurrence's day. The reminder shows the next occurrence as soon as you check the task.
Reminders fire only while the page is open in a browser tab; ones missed while it was closed alert once when you next open it. With several tabs open, each reminder alerts in one of them.
Browser notifications are optional: if they're blocked or unsupported, due tasks are still highlighted on the page.

Plain HTML, CSS and JavaScript (ES modules). The browser build needs no framework, build step or dependencies.

## Run

The local Node server serves the site and the same API handlers used by Vercel. Install dependencies with `npm ci`, configure the Development database and auth values below, then run the migrations and start the server:

```sh
node --env-file=/path/outside/the/site/.env.local db/migrate.js
node --env-file=/path/outside/the/site/.env.local server/dev.js
```

With the environment variables already exported, use `npm run db:migrate` and `npm run dev`. Open `http://localhost:3000` or the localhost origin set in `BETTER_AUTH_URL`. After sign-in, the task list is loaded from and saved to `/api/todos`.

Tasks saved by earlier versions under the `task-manager.todos.v1` localStorage key are left in place and ignored. They are not imported.

## Test

The unit tests use Node.js 20 or newer and the built-in test runner.

```sh
npm test
```

The browser-module tests stub `fetch` with an in-memory API (`test/fake-api.js`) that uses the server's own validation, and run `src/app.js` against a minimal DOM (`test/dom.js`).

Use Node.js 22.12 or later in the 22.x line for the API and database tests. Run `npm ci` and set `TEST_DATABASE_URL` to a direct URL for a disposable PostgreSQL database. The tests create empty schemas, exercise migrations, the API and the browser storage modules against the real handlers, then remove the schemas. They skip if the URL is unset.

```sh
npm run test:db
```

## Provision Neon and migrate

In the Vercel Marketplace, install Neon on the free tier in Singapore (AWS `ap-southeast-1`) and connect the existing Vercel project. Use separate database targets for Production, Preview and Development. The Vercel configuration places the Node.js Functions in Singapore and publishes only the HTML, CSS and browser modules. Enable automatic preview branching only with a data-free parent. Otherwise use a separate empty Preview database. [Neon’s Vercel Marketplace guide](https://neon.com/docs/guides/vercel-managed-integration)

| Variable | Used by | Value |
| --- | --- | --- |
| `DATABASE_URL_UNPOOLED` | Migration runner | Direct, unpooled PostgreSQL URL for the intended database or branch. If the integration uses another name, copy its direct URL into this variable. |
| `TEST_DATABASE_URL` | Database tests | Direct PostgreSQL URL for a disposable database whose role can create schemas. |
| `DATABASE_URL` (or `POSTGRES_URL`) | API and Better Auth | Pooled PostgreSQL URL from the integration. |
| `BETTER_AUTH_SECRET` | Better Auth | Server-only random secret of at least 32 characters, unique per environment. Generate one with `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | Better Auth | Required outside Preview. Use `https://task-manager-mu-sepia-18.vercel.app` in Production and `http://localhost:3000` for local auth development. |
| `VERCEL_URL` | Preview auth | Required Vercel deployment hostname, without a scheme. |
| `VERCEL_BRANCH_URL` | Preview auth | Optional Vercel Git branch alias hostname, without a scheme. |

On Preview, enable Vercel system environment variables. The deployment hostname and optional branch alias are the only accepted HTTPS origins. Each host has its own session cookie. [Vercel system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)

Keep connection strings and secrets out of Git and any directory served by the static HTTP server. For Development, run `vercel link` and `vercel env pull /path/outside/the/site/.env.local`. Confirm the direct endpoint matches the intended Neon branch, then run:

```sh
npm ci
node --env-file=/path/outside/the/site/.env.local db/migrate.js
```

If `DATABASE_URL_UNPOOLED` is already exported, run `npm run db:migrate` instead. Use the direct connection for the runner’s session advisory lock, and keep the TLS options from the Neon URL. [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)

### Release steps

Migrations run automatically in the Vercel build (`npm run build`, wired in `vercel.json`); there is no manual "migrate before merging" step.

- **Production** (`VERCEL_ENV=production`): the build applies pending migrations with `DATABASE_URL_UNPOOLED` before copying the site. Any failure fails the build, so the new code never deploys. Concurrent builds are serialized by the advisory lock.
- **Preview** (`VERCEL_ENV=preview`): Preview shares the Production database, so the build only reports pending migrations as a warning. It never writes, and never fails the build. A preview of a PR that adds a migration will error on the new columns until it merges and the Production build applies it.
- **Local** (none of `VERCEL`, `CI` or `VERCEL_ENV` set): the build step does nothing. Use `npm run db:migrate` explicitly.
- **Any hosted build** (`VERCEL` or `CI` set) with a missing or unknown `VERCEL_ENV` fails the build rather than skipping migrations. A CI job that runs `npm run build` must set `VERCEL_ENV=preview` (check only, never fails the build) or avoid the build script.

Build logs show only the stage, the migration filename and the SQLSTATE code on failure, never the database error text or URL.

`DATABASE_URL_UNPOOLED` must be available to the Production and Preview build environments.

Migrations must be additive and backward compatible (add nullable or defaulted columns and new tables; never drop, rename or tighten anything in the same release). The previous deployment keeps serving against the migrated database during the deploy and after a rollback. Remove or rename in a later release, once no running version uses it. 

Some releases skip the build and so skip migrations: instant rollback, staged promotion that reuses an existing build, and `vercel deploy --prebuilt`. (A standard Preview-to-Production promotion rebuilds with Production environment variables, so it does migrate.) As a safety net, the API checks once per function instance that every file in `db/migrations` is recorded in `schema_migrations`, using its existing database connection and reading only. If any are missing, every DB-backed API route returns `503 SCHEMA_OUT_OF_DATE` naming the missing filenames, instead of a 500 from a missing column. A passing check is cached, so there is no per-request query. The migration files are bundled with the functions through `functions.includeFiles` in `vercel.json`. After a buildless release, run `npm run db:migrate` with the Production `DATABASE_URL_UNPOOLED`.

Migration files must not contain their own `BEGIN` or `COMMIT`: the runner wraps each file and its ledger row in one transaction, and a nested `COMMIT` would break that atomicity. Every `.sql` file in `db/migrations` must be named `NNNN_name.sql`; any other `.sql` name is an error.

The runner records each file in `schema_migrations` in the same transaction as its SQL. A repeat run applies only pending files. Append changes as new four-digit numbered SQL files and leave previously applied files intact. The initial auth schema was checked against Better Auth and its CLI at version 1.7.26 with PostgreSQL and database-backed rate limiting. [Better Auth PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql)

## Server API

The email signup, sign-in and sign-out routes are `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email` and `POST /api/auth/sign-out`. Signup is open and signs the user in immediately. The minimum password length is 12 characters. Database sessions last seven days from sign-in.

`GET /api/session` returns the signed-in user’s name, email and CSRF token. Both fields in the response, `user` and `csrfToken`, are null when signed out. Send the exact app origin and `Content-Type: application/json` for all mutations, including bodyless todo deletion. Include `X-CSRF-Token` on sign-out and todo mutations. Keep that token in memory and refresh it from the session endpoint when the session changes. A todo read that includes `X-CSRF-Token` must match the current session too (403 otherwise). The app sends it on every read, so a tab left open after another account signs in can't load that account's list.

| Method and path | Request |
| --- | --- |
| `GET /api/todos` | List the signed-in user’s todos by creation date and ID. |
| `GET /api/todos?id=UUID` | Read one owned todo. An unknown or other user’s ID returns 404. |
| `POST /api/todos` | Create using `{id, text, tags}`. |
| `PATCH /api/todos?id=UUID` | Send the current `revision` and an `action` of `addTag`, `removeTag`, `setReminder`, `clearReminder`, `complete`, `markNotified` or `edit`, with that action’s fields. `edit` takes the whole editable state, `{text, tags, due, repeat}` (`due` null and `repeat` `none` for no reminder), and checks text and tags as a create does. It leaves completion alone, and re-arms the reminder only if `due` or `repeat` changes. |
| `DELETE /api/todos?id=UUID&revision=N` | Delete an owned todo at the specified revision. |

A stale revision returns 409.

## How the browser saves

`src/sync.js` keeps the rows the server confirmed and the changes still being saved. Changes show immediately and are sent one at a time, each with the revision the previous answer returned. A change the server refuses drops out of the list, and reminders are rechecked. A 409 or 404 reloads the list and asks you to try the edit again. Changes to that task made against the version you saw before the reload are cancelled, not applied to the newer version. A completion is only sent if the task is still in the state you clicked. A network or server failure offers Try again, which reloads first and re-sends only if the task is still at the version the change was sent against. Otherwise the server's version is kept. A new task whose save was uncertain goes back into the input and keeps its ID, tied to the exact text and tags (filter included), so adding it again can't create a duplicate. A 401 returns to sign-in. Signing in, up or out tells the browser's other tabs (`BroadcastChannel`); they hide their lists at once and re-read the session, discarding any read that a newer change has overtaken. A CSRF rejection does the same. Signing out or switching accounts clears the list, filters, the reminder editor, announcements, open notifications, drafts and timers, and ignores late answers from the old session. Returning to the tab re-reads the session and reloads the list before checking reminders. Each due reminder is claimed on the server (`markNotified`) before it alerts, so only one open tab alerts it. If the page closes between the claim and the alert, that occurrence is not alerted again.

## Layout

```
index.html          markup
styles.css          styles
src/todos.js        pure logic: validText, addTodo, editTodo, toggleTodo, removeTodo, addTag, removeTag, allTags,
                    filterByTags, setReminder, clearReminder, markNotified, dueReminders, nextFireTime, sortByUrgency
src/task-input.js   the add and edit fields' shared rules: readTaskInput (#tags and title check), formatTaskInput
src/tags.js         pure tag rules: normalizeTag, parseTodoInput, tagColor
src/reminders.js    pure reminder rules: normalizeReminder, isOverdue, nextOccurrence, parseLocalInput, toLocalInput
src/storage.js      every server request: session, sign-in/up/out and /api/todos (no task data in browser storage)
src/sync.js         the confirmed rows, pending changes, the request queue and reminder claims
src/auth.js         sign-in, sign-up and sign-out UI and session checks
src/app.js          DOM wiring and rendering, the reminder timer and notifications
test/               node:test unit tests
db/migrations/      numbered PostgreSQL schema migrations
db/migrate.js       `npm run db:migrate` CLI
db/runner.js        migration runner (apply and check-only modes)
server/schema-guard.js  runtime check that all migrations are applied (503 if not)
db/build-migrate.js build-time step: apply on Production, report on Preview
db/*.integration.js PostgreSQL migration and API tests
api/                Vercel Function entry points
server/             Better Auth configuration, API logic and local HTTP server
```
