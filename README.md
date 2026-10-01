# Our Days Off v14 preview

This is a local implementation candidate based on the recovered v13.6 source, whose app.js matched the deployed application. It has not been deployed. Database scripts have not been executed against PostgreSQL. Do not upload this package to production before completing RELEASE-CHECKLIST.md.

## Implemented

- Shared availability calculation with unknown-state handling, manual overrides, overnight recovery and buffers.
- Ranked Meet opportunities, Everyone free and Close enough filters, and direct plan creation with inherited start/end times.
- Updated responsive visual styles, navigation, focus states, status messages and privacy explanations.
- Server-backed private availability preferences and a migration prompt for device preferences.
- Plan end times, time zones and calendar export with daylight-saving checks.
- Import previews, duplicate checks, manual-entry preservation and safer AI image validation.
- Rotating, expiring, single-use account recovery keys.
- Proposed database permission fixes for schedule disclosure, circle-scoped feeds/polls, NULL identity checks and the internal activity logger.
- Bounded schedule loading and short-lived offline snapshots.

The permission changes are candidates, not verified remediations. Existing production accounts, data, analytics and Figma have not been changed.

## Run locally

With Node.js installed, run `npm run check` and `npm test`. Run `node tools/preview-server.mjs` and open http://127.0.0.1:4173 for a fictional-data preview. Preview changes are not saved. The browser harness requires Playwright and Microsoft Edge; its current Playwright path points to the originating workstation and must be adjusted on another machine.

`public/` is the application and `netlify/functions/` contains the AI endpoint. Never put an OpenAI secret in public configuration. The preview server injects its fixture at runtime; that fixture is not part of the production application.

## Database candidate

`database/release-v14.sql` is the combined transactional release candidate. The other database files are its source parts: do not run both the combined file and the individual parts as separate upgrades. The historical root-level v13.3 SQL is retained for provenance, not as a v14 installation step.

The candidate assumes the existing v13.6 schema and functions. It is not a fresh database bootstrap and has not been registered in Supabase migration history. Generate a staging migration with the Supabase CLI and include this candidate after verifying the staging baseline.

## Validation and remaining limitations

Sixteen automated tests cover availability, imports, calendar export and AI endpoint validation. The browser harness checks five mobile screens, desktop Home, overflow, script errors, Meet filtering and opportunity-to-plan end-time transfer using fictional data.

Real database execution, RLS/role testing, real authentication/recovery, AI provider integration, production-like imports and real mobile device checks remain outstanding. The application still contains legacy monolithic code and a floating Supabase CDN major-version dependency. This preview does not claim to complete every architectural recommendation from the audit.
