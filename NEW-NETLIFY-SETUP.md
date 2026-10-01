# Deploy this project to a NEW Netlify site

This package contains the complete local application source, assets, server function, database scripts, tests, tools and available environment templates. It includes the latest simple-shift Home screen update. Git history and old Netlify account/site linkage are excluded so the package is not linked to the previous site.

1. Create a new Netlify project and upload this entire ZIP as a source project.
2. Use the included netlify.toml: publish directory public; functions directory netlify/functions. This app has no frontend build command.
3. Configure Netlify server environment variables using .env.netlify.example. Replace the OPENAI_API_KEY placeholder with your real key using Netlify's environment-variable settings. Confirm OPENAI_ROTA_MODEL is available to your account. If necessary redeploy after setting variables.
4. The checked-in public/config.js already points to your EXISTING Supabase production project. This means the new site shares existing users, circles, schedules and plans. A new Netlify site does not create a separate database.
5. Do not run database/release-v14.sql again on the existing production database. It has already been applied. The schema snapshots are documentation/development artifacts, not production reset scripts.
6. Update allowed authentication redirect URLs in Supabase if your chosen sign-in/link flows require the new domain. A new website domain has separate browser storage: users may need the app's device-link or recovery flow to reconnect to their existing account.
7. Check Netlify reports both public files and the ai-rota function as deployed. Uploading only public/ does not include the backend function.

ENVIRONMENT FILE STATUS
Only .env.example exists in the local original project. No real .env or OpenAI secret was available. .env.netlify.example is a convenience copy for configuring Netlify, not a working secret file. Environment variables stored on the existing Netlify service are not automatically transferred with this ZIP. Never put OPENAI_API_KEY in public/config.js or anywhere under public/.

FOLDERS
public/ - deployed frontend and assets
netlify/functions/ - server-side AI handler
database/ - migration, schema documentation and staging-only regression SQL
tests/ - existing automated tests
tools/ - local-only preview utilities (not production entry points)
docs/ - developer documentation; historical handover notes may describe prior deployment status

The files were packaged without changing or deploying the live app. Local tools can contain workstation-specific paths and fictional fixtures; they are not required for Netlify deployment. No private user database rows or saved login sessions are included.
