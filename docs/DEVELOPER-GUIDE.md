# Developer guide

## Architecture and file map

The application is a vanilla JavaScript ES-module web app. `public/index.html` loads `app.js`; `styles.css` and `design-system.css` supply presentation. `availability.js` contains pure interval logic. `calendar-export.js` converts plan wall-clock times to UTC calendar values. `sw.js` caches the web shell and dependencies. Icons and the web manifest are included.

The browser talks to Supabase Auth and the PostgREST API/RPC functions. `netlify/functions/ai-rota.mjs` verifies the bearer token with Supabase, verifies that the user has a mapped profile, then submits selected images to OpenAI's Responses API. Netlify routes `/api/ai-rota` to that function. Server credentials must remain on the server.

The app is not a React or Next.js application and does not currently have a frontend compilation step. Preserve the existing logic while introducing modules and a bundler incrementally.

## Local setup

1. Extract the package and put `source/` in an owner-controlled private repository. Install a supported Node.js LTS release. Record/pin the chosen runtime in the repository.
2. Work against an isolated development Supabase project. Configure `source/public/config.js` with that project's URL and publishable key. Those fields have intentionally been replaced with placeholders in this handover.
3. Enable and configure anonymous sign-in in that development project if retaining the existing authentication flow. Verify the allowed redirect URLs and browser/native origins. No production Auth settings are exported here.
4. For a static preview, serve `public/` over HTTP, for example `python -m http.server 4173 --directory public` from `source/`. This requires Python and does not run the AI function.
5. For server-function development, install the official Netlify CLI, consult its current `--help`, and run `netlify dev` from `source/`. Supply environment variables privately. Confirm its local publish/functions paths use `netlify.toml`.
6. Existing checks are `npm run check` and `npm test`. There is no dependency lockfile in the original source because browser libraries load from CDNs. Build a pinned local dependency graph before mobile release.

Do not point a developer's local frontend at production merely to make onboarding work. Seed fictional accounts and circles in development instead.

## Configuration

| Setting | Location | Purpose |
|---|---|---|
| SUPABASE_URL | public/config.js and server environment | Project API URL |
| SUPABASE_PUBLISHABLE_KEY | public/config.js and server environment | Public client key; RLS still enforces access |
| OPENAI_API_KEY | Netlify server environment only | AI screenshot extraction |
| OPENAI_ROTA_MODEL | Netlify server environment | Model override; source fallback is gpt-5.6-terra |

Verify model availability in the owner's OpenAI project before configuring it. No model entitlement, retention setting or billing limit was exported. No service-role key is required by the current AI function. Never embed one in the native app.

`netlify.toml` publishes `public`, bundles `netlify/functions`, and redirects `/api/ai-rota`. The function and public files must deploy together. The previous publishing workflow uploaded a source ZIP containing `public/`, `netlify/`, `netlify.toml` and `package.json`; Netlify built and published the function. Prefer CI from the private repository for future releases. Select the correct existing Netlify site explicitly; this package excludes `.netlify` account linkage and tokens.

## Browser dependencies

| Library | Current reference | Use |
|---|---|---|
| @supabase/supabase-js | @2 via jsDelivr +esm (floating) | Auth and database |
| pdfjs-dist | 4.10.38 | PDF reading and worker |
| qrcode | 1.5.4 | QR generation |
| xlsx | 0.18.5 | Spreadsheet import |
| tesseract.js | @5 (floating) | OCR |
| jspdf | 2.5.2 | PDF export |

The package contains references, not vendored third-party binaries. Internet access is required for those libraries in the current web app. Audit versions, licenses and advisories, pin exact versions, add a lockfile and bundle workers/assets for mobile. This list is an inventory, not a recommendation to retain these versions.

## Database handover and migrations

`public-schema.json` lists columns, defaults, constraints, indexes, policies, grants and triggers for 30 public tables. `current-functions.sql` and `FUNCTION-INDEX.md` contain the 118 current public functions. `current-public-schema.sql` reconstructs those objects for an EMPTY Supabase development project, using existing platform Auth roles/functions. It was generated from catalogs and has not been restore-tested; it is not a full pg_dump.

Two distinct setup paths:

- Existing v13.6 database: the deployed `release-v14.sql` is the upgrade, recorded as migration 20260926061115. Production already has this migration: DO NOT apply it again as a new upgrade.
- Empty development database: obtain an owner-authorized schema-only Supabase/pg_dump export for authoritative restoration, or review and validate the supplied current-schema reconstruction. It already contains v14; DO NOT follow it with the same v14 upgrade. Confirm extensions, sequence permissions, realtime publication membership and all function grants separately.

Historical migration gaps must be baselined in a controlled development workflow before future migrations are generated with the Supabase CLI. Never reset production to reconcile history. The schema snapshot excludes migration internals, auth users, storage contents, platform defaults and project API configuration.

`app_network_config` is configuration data, not exported customer data. Inspect the onboarding functions and seed a fictional network configuration in development. A schema alone is insufficient to reproduce every onboarding state. No live group IDs or invitation codes should be copied into seed files.

## Schema map

| Area | Tables |
|---|---|
| Identity/network | groups, members, member_devices, device_link_codes, app_network_config |
| Personal schedule | days_off, meal_availability_overrides, member_shift_definitions, member_availability_preferences |
| Circle access | shared_circles, shared_circle_memberships, circle_invites, circle_join_requests |
| Plans | group_events, event_rsvps, event_plan_notes, event_location_options, event_location_votes |
| Date polls | group_polls, group_poll_options, group_poll_votes |
| Legacy/personal groupings | personal_circle_defs, personal_member_circles, personal_compare_sets, personal_schedule_profiles, personal_schedule_profile_members |
| Activity/recovery | member_activity, group_activity_feed, app_activity_log, account_recovery_keys |

Do not delete legacy tables merely because their UI was simplified. Inspect functions and foreign-key dependencies first.

## Authentication and permissions

Startup calls Supabase anonymous sign-in when no session exists. `member_devices` associates an Auth user ID with a stable member. `current_member_id()` and `current_group_id()` derive identity from that mapping. Account continuity depends on device linking/recovery, not a traditional email/password screen. Define how existing web users move to mobile without creating duplicate personal schedules.

RLS protects direct table access. Many operations use SECURITY DEFINER functions and therefore require explicit authorization inside each function. Do not replace them with client-side checks. Inspect exact current SQL, including inherited functions not changed by v14.

Raw `days_off` and meal override reads are self-only. `get_group_schedule_visible_v14` returns permitted peer schedule projections within a bounded date range; `get_availability_v14` returns shared intervals, excluding viewer-only peers. Private preferences and recovery hashes have no direct client table grants. Missing policies on those private tables are intentional, not permission errors to fix by opening access.

Free/busy visibility masks raw shift times; shifts visibility exposes times but not private notes; details visibility permits the fuller projection. Current-user details remain accessible. Derived free windows inherently disclose availability: explain this in privacy copy.

`set_recovery_key_v14` hashes a client-generated random key; `recover_account_v14` consumes it once and links a new device. Rotation and expiry are implemented; existing linked devices are retained. Never export keys, hashes or sessions to the developer package.

## Product rules — acceptance requirements

- One account, one personal schedule, multiple private circles. Circles do not own the personal rota.
- No unrestricted public circle directory. Search/invites disclose only the intended minimal prejoin information.
- Working members participate in overlap calculations; viewers do not inflate availability counts.
- Missing/unknown schedules are never treated as free.
- Manual availability overrides take precedence. Rota import must preserve manual rows and unselected dates and reject duplicate person/date mappings.
- Overnight shifts, travel buffers and recovery affect free time on the correct dates. Zero recovery settings must remain valid.
- Full-day freedom is distinct from partial shared hours. Days Off, Magic Hour, Compare and Meet must agree on the same underlying availability.
- Breakfast override covers 00:00–12:00, lunch 12:00–16:00, dinner 16:00–24:00. Existing social result periods differ (Breakfast 08:00–16:00); do not silently change these semantics.
- Plans belong to circles. RSVP, suggestions, votes and notes respect membership. Circle deletion must preserve accounts and personal schedules.
- Today opens on Working time. It shows today's rota entry with simple Day shift/Night shift/Off wording and shift hours, respecting privacy. Yesterday's shift is not duplicated here. Off time still uses recovery-aware derived availability.
- Current shift label classification treats shifts ending at or before their start as overnight/Night shift; it is not an employer-defined shift taxonomy.

## Validation evidence and gaps

Previously completed: 16 JavaScript tests (availability, import handling, calendar export, mocked AI endpoint), syntax checks, five mobile-size browser screens and desktop Home using fictional data. Meet filters and window-to-plan end-time transfer were checked. Staging SQL regression checks passed for self-only reads, masked peer details, circle-scoped polls/feed, viewer exclusion, lunch overrides, night recovery, unknown days, private preferences, NULL identity deletion denial, manual import preservation, plan validation and one-use recovery. Fixtures were rolled back.

The SQL checks used database roles and injected request identity settings; they are not a substitute for end-to-end JWT/Auth tests. The new Today card tweaks were published with successful Netlify build status, without a new regression suite at the owner's request. No additional app tests were run for this handover.

Outstanding: real-device native testing; full auth/reinstall/migration flow; real provider AI round-trip; DST repeated-hour handling; time-zone/date boundaries; malformed-input parity between SQL and JS; performance at larger circle sizes; import concurrency; recovery abuse controls; full account deletion; moderation/report/block flows for shared user content; native accessibility. The code remains a large app.js monolith. Supabase dependency and OCR reference float on major versions. Supabase advisors flagged broad legacy definer function exposure; this is not a completed repository-wide security certification.

## Release and rollback

Keep web, API and database changes backward-compatible with previously installed mobile versions. A store rollout cannot update every client immediately. Use additive migrations and versioned RPCs. Preserve an owner-controlled database backup and the prior Netlify deployment reference before future releases. Rolling back Netlify does not roll back database changes. Do not reverse permission fixes casually or drop populated tables. Document and rehearse a separate database rollback plan in staging.
