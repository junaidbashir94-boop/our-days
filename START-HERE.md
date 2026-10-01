# Our Days Off — developer handover

Prepared 28 September 2026. This is a source and documentation handover, not an App Store or Google Play submission-ready binary. No production changes were made to prepare it.

## What you are receiving

- `source/`: the web application's HTML, JavaScript, styles, icons, service worker, AI server function, Netlify configuration and existing automated tests.
- `database/`: the deployed v14 migration, production migration history, current public schema metadata, all 118 function definitions, a logical schema reconstruction and a transactional staging regression script.
- `docs/`: setup, architecture, mobile implementation, store requirements, known gaps and secure access guidance.
- `MANIFEST-SHA256.json`: checksums for the delivered files.

Start with `docs/DEVELOPER-GUIDE.md`, then `docs/MOBILE-AND-STORES.md`. The owner can send this entire ZIP to the developer. Credentials, personal schedules, account rows, recovery keys and authentication sessions are not included.

## Release identity

The source is taken from the package published on 26 September 2026 as Netlify deployment `6ab8323f2c4a38a1b376e2da` (simple shifts). This includes the earlier v14 redesign and the Today card updates: Working time opens by default; today's shift is shown as Day shift or Night shift with its hours; Off time retains derived availability.

Production site: https://stately-kelpie-39db53.netlify.app/

Production database migration recorded by Supabase: `20260926061115_availability_privacy_plans_v14`. Public schema metadata was retrieved read-only on 28 September 2026. Older v13 schema changes are not recorded in the returned migration history, so this is not a complete historical migration chain.

The deployed package is the provenance reference. A new download of live files could not be completed because the local HTTP client reported an authentication/TLS failure. Do not treat this as independent confirmation that nobody has deployed a later version outside this conversation. Before taking ownership, reconcile Netlify's currently published deployment with the release above.

## Already implemented

Private circles, one personal schedule across circles, manual and uploaded rota entry, AI-assisted screenshot import, Days Off, Magic Hour, selected-person comparison, Meet suggestions, plans, RSVP, suggestions/voting, notes, profile/theme controls and schedule privacy. v14 adds shared derived availability, private preferences, bounded schedule reads, import preview/protection, plan end times/time zones, calendar export and recovery keys. The Home card now defaults to simple working shifts.

These are web features. No Xcode project, Android project, native signing credentials, native push service, store listing or approved store binary has been created.

## What the developer must deliver

Create maintainable iOS and Android applications using the existing product and backend. Preserve existing accounts and scheduling rules. Resolve the documented mobile, deletion and privacy gaps; deliver reproducible builds, a private source repository, owner-controlled signing, TestFlight and Play test releases, store assets, review instructions and an operational handover. Store acceptance is decided by Apple and Google and is not guaranteed by this package.

## Important distinction

The included SQL snapshot describes the current public schema; it is not a backup of customer data or the entire Supabase project. Auth settings, storage/realtime configuration, provider settings, secrets, external services and environment values require owner-granted access. The current schema reconstruction is an unexecuted convenience artifact for an empty development project. Do not run it against production.
