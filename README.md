# task-manager

A small todo list app that keeps your tasks in the browser. Add a task, tick it off, delete it.
Tasks are saved to `localStorage`, so they survive a page reload.
Type `#tags` in a new task (`Pay rent #home`) to tag it; each tag gets a fixed color from its name, and the tag chips filter the list (any selected tag matches).
Give a task a reminder ("+ reminder": a date and time, repeating daily or weekly if you like). Overdue tasks are marked and listed first.
Reminders fire only while the page is open in a browser tab; ones missed while it was closed alert once when you next open it.
Browser notifications are optional: if they're blocked or unsupported, due tasks are still highlighted on the page.

Plain HTML, CSS and JavaScript (ES modules). The browser build needs no framework, build step or dependencies.

## Run

The app uses ES modules, which browsers won't load from a `file://` URL, so serve the folder over HTTP:

```sh
python3 -m http.server 8000
# or: npx serve .
```

Then open http://localhost:8000 (if you used `npx serve`, open the URL it prints).

## Test

The unit tests use Node.js 20 or newer and the built-in test runner.

```sh
npm test
```

To test migrations, install dependencies with `npm ci` and set `TEST_DATABASE_URL` to a direct URL for a disposable PostgreSQL database. The test creates an empty schema, checks concurrent replay and reruns, then removes the schema. It skips if the URL is unset.

```sh
npm run test:db
```

## Provision Neon and migrate

In the Vercel Marketplace, install Neon on the free tier in Singapore (AWS `ap-southeast-1`) and connect the existing Vercel project. Use separate database targets for Production, Preview and Development, and place the Vercel Functions in Singapore when they are added. Enable automatic preview branching only with a data-free parent. Otherwise use a separate empty Preview database. [Neon’s Vercel Marketplace guide](https://neon.com/docs/guides/vercel-managed-integration)

| Variable | Used by | Value |
| --- | --- | --- |
| `DATABASE_URL_UNPOOLED` | Migration runner | Direct, unpooled PostgreSQL URL for the intended database or branch. If the integration uses another name, copy its direct URL into this variable. |
| `TEST_DATABASE_URL` | Database tests | Direct PostgreSQL URL for a disposable database whose role can create schemas. |
| `DATABASE_URL` (or `POSTGRES_URL`) | Upcoming API and Better Auth | Pooled PostgreSQL URL from the integration. |
| `BETTER_AUTH_SECRET` | Upcoming Better Auth | Server-only random secret, unique per environment. Generate one with `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | Upcoming Better Auth | Canonical app origin. Use `https://task-manager-mu-sepia-18.vercel.app` in Production and `http://localhost:3000` for local auth development. |
| `VERCEL_URL` | Upcoming Preview auth | Vercel-provided deployment hostname for the Preview origin when `BETTER_AUTH_URL` is unset. Enable Vercel system environment variables for Preview. |

Keep connection strings and secrets out of Git and any directory served by the static HTTP server. For Development, run `vercel link` and `vercel env pull /path/outside/the/site/.env.local`. Confirm the direct endpoint matches the intended Neon branch, then run:

```sh
npm ci
node --env-file=/path/outside/the/site/.env.local db/migrate.js
```

If `DATABASE_URL_UNPOOLED` is already exported, run `npm run db:migrate` instead. Use the direct connection for the runner’s session advisory lock, and keep the TLS options from the Neon URL. Apply migrations separately from deployments and request handling. Migrate the actual Preview branch before testing it and the Production target before merging the first release that uses the database. [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)

The runner records each file in `schema_migrations` in the same transaction as its SQL. A repeat run applies only pending files. Append changes as new four-digit numbered SQL files and leave previously applied files intact. The initial auth schema was checked against Better Auth and its CLI at version 1.7.26 with PostgreSQL and database-backed rate limiting. [Better Auth PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql)

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
db/migrations.integration.js  PostgreSQL migration test
```
