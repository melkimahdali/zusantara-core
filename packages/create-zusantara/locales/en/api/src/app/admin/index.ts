import { defineAdmin } from "zusantara/admin";
import { appPage } from "../lib/ui.js";

// zusantara:generated:begin admin-resources sha256=56fb73e96eae
import notesAdmin from "./notes.js";
import usersAdmin from "./users.js";

const resources = [notesAdmin, usersAdmin];
// zusantara:generated:end admin-resources

/** Admin panel at /admin (routes in src/app/routes/admin). Tables are added by `zusantara make:admin <table>`. */
export const admin = defineAdmin({
  resources,
  // The app's page frame, so the admin panel uses the same navigation.
  layout: (ctx, options, ...children) => appPage(ctx, options, ...children),
  // Site settings page at /admin/_settings. Read them in a route with: const s = await admin.settings();
  settings: {
    fields: [
      { name: "siteName", label: "Site name", default: "My App" },
      { name: "contactEmail", label: "Contact email", type: "email" },
      { name: "openingHours", label: "Opening hours", type: "textarea", hint: "E.g. Monday–Friday 8am–5pm" },
    ],
  },
});

/** Admin menu for the app navigation (only shown to users with access). */
export const adminNav = admin.nav;
