# task-manager

A small todo list app that keeps your tasks in the browser. Add a task, tick it off, delete it.
Tasks are saved to `localStorage`, so they survive a page reload.
Type `#tags` in a new task (`Pay rent #home`) to tag it; each tag gets a fixed color from its name, and the tag chips filter the list (any selected tag matches).
Give a task a reminder ("+ reminder": a date and time, repeating daily or weekly if you like). Overdue tasks are marked and listed first.
Reminders fire only while the page is open in a browser tab; ones missed while it was closed alert once when you next open it.
Browser notifications are optional: if they're blocked or unsupported, due tasks are still highlighted on the page.

Plain HTML, CSS and JavaScript (ES modules). The browser build needs no framework, build step or dependencies.

## Run

The local Node server serves the site and the same API handlers used by Vercel. Install dependencies with `npm ci`, configure the Development database and auth values below, then run the migrations and start the server:

```sh
node --env-file=/path/outside/the/site/.env.local db/migrate.js
node --env-file=/path/outside/the/site/.env.local server/dev.js
```

With the environment variables already exported, use `npm run db:migrate` and `npm run dev`. Open `http://localhost:3000` or the localhost origin set in `BETTER_AUTH_URL`. After sign-in, tasks are still read from and written to this browser’s localStorage.

## Test

The unit tests use Node.js 20 or newer and the built-in test runner.

```sh
npm test
```

Use Node.js 22.12 or later in the 22.x line for the API and database tests. Run `npm ci` and set `TEST_DATABASE_URL` to a direct URL for a disposable PostgreSQL database. The tests create empty schemas, exercise migrations and the API, then remove the schemas. They skip if the URL is unset.

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

If `DATABASE_URL_UNPOOLED` is already exported, run `npm run db:migrate` instead. Use the direct connection for the runner’s session advisory lock, and keep the TLS options from the Neon URL. Apply migrations separately from deployments and request handling. Migrate the actual Preview branch before testing it and the Production target before merging the first release that uses the database. [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)

The runner records each file in `schema_migrations` in the same transaction as its SQL. A repeat run applies only pending files. Append changes as new four-digit numbered SQL files and leave previously applied files intact. The initial auth schema was checked against Better Auth and its CLI at version 1.7.26 with PostgreSQL and database-backed rate limiting. [Better Auth PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql)

## Server API

The email signup, sign-in and sign-out routes are `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email` and `POST /api/auth/sign-out`. Signup is open and signs the user in immediately. The minimum password length is 12 characters. Database sessions last seven days from sign-in.

`GET /api/session` returns the signed-in user’s name, email and CSRF token. Both fields in the response, `user` and `csrfToken`, are null when signed out. Send the exact app origin and `Content-Type: application/json` for all mutations, including bodyless todo deletion. Include `X-CSRF-Token` on sign-out and todo mutations. Keep that token in memory and refresh it from the session endpoint when the session changes.

| Method and path | Request |
| --- | --- |
| `GET /api/todos` | List the signed-in user’s todos by creation date and ID. |
| `GET /api/todos?id=UUID` | Read one owned todo. An unknown or other user’s ID returns 404. |
| `POST /api/todos` | Create using `{id, text, tags}`. |
| `PATCH /api/todos?id=UUID` | Send the current `revision` and an `action` of `addTag`, `removeTag`, `setReminder`, `clearReminder`, `complete` or `markNotified`, with that action’s fields. |
| `DELETE /api/todos?id=UUID&revision=N` | Delete an owned todo at the specified revision. |

A stale revision returns 409. The current browser task list still uses localStorage.

## Layout

```
index.html          markup
styles.css          styles
src/todos.js        pure logic: addTodo, toggleTodo, removeTodo, addTag, removeTag, allTags, filterByTags,
                    setReminder, clearReminder, markNotified, dueReminders, nextFireTime, sortByUrgency
src/tags.js         pure tag rules: normalizeTag, parseTodoInput, tagColor
src/reminders.js    pure reminder rules: normalizeReminder, isOverdue, nextOccurrence, parseLocalInput, toLocalInput
src/storage.js      load()/save() against localStorage key "task-manager.todos.v1"
src/app.js          DOM wiring and rendering, the reminder timer and notifications
test/               node:test unit tests
db/migrations/      numbered PostgreSQL schema migrations
db/migrate.js       migration runner
db/*.integration.js PostgreSQL migration and API tests
api/                Vercel Function entry points
server/             Better Auth configuration, API logic and local HTTP server
```
