# Giving the developer access

Send the ZIP first. It is designed to be useful without customer records or passwords. Do not send an export of real schedules, recovery keys, Auth users, signing keys or your personal browser profile.

1. Keep the source repository, Supabase organization/projects, Netlify site, OpenAI project and store accounts owned by you or your organization.
2. Invite the developer with their own account. Grant repository access and staging project/site access first. Use the narrowest available role and app/project scope. If the service cannot restrict access sufficiently, use a separate staging organization/project instead of granting broad production access.
3. Give store access through App Store Connect Users and Access and Play Console Users and permissions. Keep account ownership, billing and final release permissions with the owner unless deliberately delegated.
4. Put server secrets into the hosting/CI secret manager yourself, or share a staging-only scoped credential through a password manager's controlled sharing. Never paste secrets into chat, issue trackers, public repositories or this ZIP. Set spend limits where available.
5. Give the developer a staging Supabase URL and publishable key separately. Public keys are designed for client use, but do not grant direct privileged access; RLS and RPC authorization remain essential. Do not provide a service-role key for frontend development.
6. Use separate credentials for staging and production. Grant production access only for a defined task and duration. Require review of migrations and releases, keep backups and preserve an audit trail.
7. At completion, remove unnecessary invitations, rotate any credentials that were shared, retain signing/recovery ownership and confirm the owner can build and publish independently.

Owner decisions still required: legal publishing entity, developer identity, bundle/package identifiers, support/privacy domain, retention policy, target countries/audience, optional notifications and business model. No accounts, invitations, credentials or store listings were created by this handover task.

## Exclusions

The package intentionally excludes `.git`, `.netlify`, actual environment files, platform credentials, device sessions, database table rows, user-uploaded rota images, recovery keys/hashes, analytics exports and production screenshots containing real people. Public configuration values were replaced with placeholders. SQL function parameters mentioning keys are code definitions, not key values.

The current database metadata contains object names and permission definitions only. The schema's existence does not reveal the contents of the corresponding tables. Source comments and fictional tests are retained. Do not use fictional regression fixture keys as application credentials.
