# Release gates — not yet satisfied

The live application is unchanged. A separate Supabase staging project and a production-like, anonymized baseline are needed for the following checks. Do not use production as the test fixture.

## Database and permissions

1. Confirm baseline schema/function signatures match the release candidate; retain schema and data backups. Register a CLI-generated migration in staging and execute the combined candidate there. Confirm the entire transaction succeeds.
2. Exercise anonymous, authenticated-unlinked, pending, outsider, working-member, viewer and circle-manager sessions. Use real JWT-bound sessions, not only an owner SQL session.
3. Verify raw days_off and meal override reads are self-only; schedule RPC disclosure matches each privacy setting. Availability RPCs must return permitted windows without private shift details or preference values. Unknown days must remain unknown.
4. Verify polls and feed reads never cross circle boundaries. NULL/unlinked identities must not delete members, polls or options. Outsiders must be denied even when they know UUIDs. Last-manager protection must hold.
5. Confirm API roles cannot execute the internal activity logger or access preference/recovery tables directly; legitimate internal logging still works.
6. Compare SQL availability against JavaScript fixtures: lunch overrides, previous-night recovery, next-day buffers, zero recovery settings, malformed input and explicit unknown days. Test date limits and viewer exclusion.

## Functional integration

7. Import screenshot, PDF and spreadsheet fixtures. Check exact preview counts, duplicate rejection, manual-entry preservation, unchanged unselected dates, owner/member permissions and partial failure reporting.
8. Save preferences on one device and verify overlap results on another. Verify old device settings are offered for explicit migration and refreshed overrides change results immediately.
9. Create and edit circle plans; verify ownership, cross-circle denial, overnight duration, time zones, calendar exports and Going/Maybe/Can't. Check both existing plans without end times and new plans.
10. Generate a recovery key; verify linked/unlinked device rules, successful single use, replay denial, expiry and rotation. Verify old device access is intentionally retained. Never log keys.
11. Exercise authentication, private invitations, minimal prejoin disclosure, circle switching, viewer membership and circle deletion without deleting personal schedules.
12. Check slow/offline operation, snapshot expiry, restored connectivity, real iOS/Android layouts, keyboard navigation and screen reader names. Test AI endpoint using a staging-only provider secret and bounded fixtures.

## Coordinated release

13. Pin and verify external dependency versions; review the full diff and staging evidence. Keep analytics unchanged unless separately authorized.
14. Prepare and rehearse rollback in staging. Some data and permission changes cannot safely be reversed by merely restoring frontend files. Record the exact database and frontend versions together.
15. Obtain approval for the concrete tested release before applying production migrations or deploying. Apply the verified database migration before the dependent frontend, monitor authentication/import/availability errors, and stop on permission regressions.

No gate above is implied to have passed by the JavaScript or fictional-data browser tests.
