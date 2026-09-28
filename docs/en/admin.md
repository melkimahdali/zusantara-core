---
title: Admin panel
order: 2
group: Front-End
description: Data management pages from your database schema in one command, with search, filters, per-role access, htmx, and tests.
---

# Admin panel

`zusantara make:admin` builds data management pages from the tables in `src/app/db/schema.ts`: a dashboard, lists with search, filters, and sorting, create and edit forms, delete, edit in place in the table, and tests. The panel uses the UI kit and your app theme, works without JavaScript, and gets faster with htmx.

```bash
npx zusantara make:admin products            # one table (table name or export name in the schema)
npx zusantara make:admin products categories
npx zusantara make:admin --all               # every table
```

Open `/admin` while `zusantara dev` is running. New projects from the `api` template already have a panel for the `users` and `notes` tables.

## Generated files

| File | Contents |
|---|---|
| `src/app/admin/<table>.ts` | one table: labels, fields, access, and your customizations |
| `src/app/admin/index.ts` | the panel's tables and `adminNav` for the app menu |
| `src/app/routes/admin/index.ts` | the `/admin` dashboard |
| `src/app/routes/admin/[...path].ts` | every table page under `/admin/*` |
| `test/admin-<table>.test.ts` | tests for the list, forms, and access (when the project has a `test/` folder and migrations) |

An **Admin** item is added to `navFor()` in `src/app/lib/ui.ts`, and it only shows for users who may view at least one table. When `src/app/lib/auth.ts` has `requireUserPage`, the admin routes use it, so guests are sent to `/login`.

```ts
// src/app/admin/products.ts
import { defineResource, type GeneratedResource } from "zusantara/admin";
import { db } from "../db/index.js";
import { products } from "../db/schema.js";

// zusantara:generated:begin admin-resource sha256=4f0c2a9d1b7e
const generated: GeneratedResource = {
  name: "products",
  label: "Products",
  singular: "Product",
  titleField: "name",
  fields: [
    { name: "id", label: "ID", type: "number", form: false, sort: true },
    { name: "name", label: "Name", type: "text", required: true, search: true, sort: true },
    { name: "status", label: "Status", type: "enum", options: ["draft", "live"], filter: true, sort: true, inline: true },
    { name: "categoryId", label: "Category", type: "relation", relation: { labelKey: "name" }, filter: true, sort: true },
  ],
};
// zusantara:generated:end admin-resource

export default defineResource({
  ...generated,
  table: products,
  db,
  access: { view: ["admin", "staff"], create: ["admin"], update: ["admin"], delete: ["admin"] },
  overrides: { name: { label: "Product name" } },
});
```

## Running it again after the schema changes

After adding a column, run `make:admin` for that table again. The generator only rewrites the contents of the `zusantara:generated` block, so `access`, `overrides`, and your code outside the block stay as they are.

The block's opening line stores a sha256 fingerprint of its contents. When the block was edited by hand, `make:admin` does not overwrite it and tells you which file it skipped. Move that change into `overrides`, or run with `--force` if you really want to overwrite it.

The complete flow for *"add a status column to products"*, which Zusantara AI also runs:

```bash
# 1. add the column in src/app/db/schema.ts
npx zusantara db:generate && npx zusantara db:migrate
npx zusantara make:admin products
npm test
```

## Fields

Field types come from the Drizzle columns:

| Type | From column | Form | List |
|---|---|---|---|
| `text`, `email`, `url`, `textarea` | text (email/url/body/description recognized by name) | input, textarea | text, link |
| `number` | integer, real, numeric | number input | formatted number |
| `boolean` | `integer({ mode: "boolean" })`, `boolean()` | switch | Yes/No, editable in place |
| `enum` | `text({ enum: [...] })`, `pgEnum` | select | badge, editable in place |
| `date`, `datetime` | date, timestamp | date input | localized date |
| `relation` | a column with `.references()` | Combobox with server-side search | the target's label, clickable |
| `image`, `file` | columns named image/photo/avatar/file/... | FileInput with preview | thumbnail, link |
| `json` | `json()`, `text({ mode: "json" })` | JSON textarea | summary |

Every field has settings you can change through `overrides`:

| Option | Meaning |
|---|---|
| `label`, `hint` | text for people |
| `list: false` | not shown in the list |
| `form: false`, `readonly: true` | not in the form, or shown but not editable |
| `search`, `filter`, `sort` | part of search, has a filter, sortable |
| `inline` | editable in place in the list (boolean and enum) |
| `required` | must be filled in |
| `options` | choices for enum |
| `types`, `maxBytes` | file types and size for image/file, same as `saveUpload` |

Secret columns (password, hash, token, secret, salt, API key, OTP, recovery codes) never show in the panel, the tests, or `describe`, whatever the configuration says. When a required column cannot be filled from the form, such as `password_hash`, adding records for that table is turned off and those records are created from your app code.

## Search, filters, and sorting

- Search `?q=` looks in every `search` field (text, case-insensitive) and also the ID when it is a number.
- Filters follow the type: a select for enum, Yes/No for boolean, a from/to range for dates (and for numbers when the field has `filter: true`). Relation filters are read from the URL, e.g. `/admin/notes?f_userId=3`.
- Click a column header to sort. Default order: `defaultSort`, or newest first.
- With htmx, results update as you type without reloading the page, and the URL in the address bar stays clean so it can be shared.

## Access

```ts
access: {
  view: ["admin", "staff"],
  create: ["admin"],
  update: (user) => user.role === "admin" || user.id === 1,
  delete: false,
},
```

Each action (`view`, `create`, `update`, `delete`) is set separately with a list of roles, `true`/`false`, or a function. An action you leave out is for the `admin` role only, and does not inherit `view`. The role is read from `ctx.state.user.role`. Guests get 401 (or are sent to the login page by the middleware), other roles get 403. Buttons for actions a user may not take are not shown.

## Validation and error messages

An invalid form comes back with status 422 and a message under each field. Database errors are translated too: a unique value that is already taken shows on its field ("This email is already used by another record."), and records still referenced by another table are not deleted.

For your own rules, use `beforeSave`. It also runs for edits in place in the table (with `values` holding just that one column):

```ts
import { AdminError, defineResource } from "zusantara/admin";

export default defineResource({
  ...generated,
  table: products,
  db,
  beforeSave(values, ctx, existing) {
    if (typeof values.name === "string") values.slug = values.name.toLowerCase().replace(/\s+/g, "-");
    if (values.price !== undefined && Number(values.price) < 0) throw new AdminError("The price cannot be negative.", "price");
  },
});
```

## Look

The panel uses your app's `appPage()` when there is one, so the navigation and theme match your other pages; otherwise it has its own frame. On phones, tables turn into one card per record. Every admin page is sent with `X-Robots-Tag: noindex` and `Cache-Control: no-store`.

## Without the generator

`defineResource({ table, db })` is enough for a simple table: the name, label, and fields are read straight from the schema.

```ts
import { defineAdmin, defineResource } from "zusantara/admin";

export const admin = defineAdmin({
  resources: [defineResource({ table: products, db }), defineResource({ table: categories, db, access: { delete: false } })],
  basePath: "/admin",
});
```

## Testing the panel

`testAdmin(admin)` sends requests straight to the panel, with no server and no sign-in:

```ts
import { testAdmin } from "zusantara/admin";

const t = testAdmin(admin);
assert.equal((await t.get("/admin/products", { role: "admin" })).status, 200);
assert.equal((await t.post("/admin/products", { name: "Coffee", price: 18000 }, { role: "admin" })).status, 303);
assert.equal((await t.get("/admin/products", { role: "guest" })).status, 403);
```

## App manifest: `zusantara describe`

```bash
npx zusantara describe          # summary to read
npx zusantara describe --json   # manifest for AI and other tools
```

It lists routes and methods, tables with their columns, relations, and types, the admin panel with its access rules, jobs, and plugins. Secret columns are left out, only their count is given (`hiddenColumns`), and data is never read. `describe` also suggests indexes for columns the panel searches, filters, or sorts on that do not have one yet. Zusantara AI uses this manifest as context, and it will be the main tool of `zusantara mcp`.

## htmx

The panel is built with htmx, which ships with Zusantara. You can use it on your own pages through the `hx` prop in the UI kit; see [UI kit: htmx](ui.html#htmx).
