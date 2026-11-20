# task-manager

A small todo list app that keeps your tasks in the browser. Add a task, tick it off, delete it.
Tasks are saved to `localStorage`, so they survive a page reload.
Type `#tags` in a new task (`Pay rent #home`) to tag it; each tag gets a fixed color from its name, and the tag chips filter the list (any selected tag matches).
Give a task a reminder ("+ reminder": a date and time, repeating daily or weekly if you like). Overdue tasks are marked and listed first.
Reminders fire only while the page is open in a browser tab; ones missed while it was closed alert once when you next open it.
Browser notifications are optional: if they're blocked or unsupported, due tasks are still highlighted on the page.

Plain HTML, CSS and JavaScript (ES modules). No framework, no build step, no dependencies.

## Run

The app uses ES modules, which browsers won't load from a `file://` URL, so serve the folder over HTTP:

```sh
python3 -m http.server 8000
# or: npx serve .
```

Then open http://localhost:8000 (if you used `npx serve`, open the URL it prints).

## Test

Needs Node.js 20 or newer. The tests use Node's built-in test runner, so there is nothing to install:

```sh
npm test
```

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
```
