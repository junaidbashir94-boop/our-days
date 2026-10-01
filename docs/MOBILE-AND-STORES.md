# Mobile implementation and store checklist

Prepared 28 September 2026. Recommendations below are not already implemented. Recheck the official requirements when submitting; store rules and tooling change.

## Recommended approach

Use Capacitor with bundled web assets for the first iOS and Android releases. This preserves the existing JavaScript scheduling engine and Supabase backend while adding platform integrations. Capacitor supports packaging existing web applications for both platforms: https://capacitorjs.com/docs and https://capacitorjs.com/docs/getting-started . This recommendation follows from this app's existing architecture; it is not a guarantee of store approval.

A full Swift/Kotlin or React Native rewrite would cost more and introduce scheduling-parity risk. Reconsider it only if profiling or usability evidence shows a native wrapper cannot meet requirements. A remote website loaded into a thin shell is not the intended deliverable: bundle the app, provide mobile navigation and useful native integrations, and address Apple's minimum-functionality review requirement. https://developer.apple.com/app-store/review/guidelines/

## Implementation sequence

1. Establish an owner-controlled Git repository, development/staging environments and reproducible dependency install. Pin a compatible Capacitor/toolchain version and bundle existing CDN libraries using a maintained bundler. Preserve testable scheduling modules.
2. Add Capacitor iOS and Android projects with owner-approved bundle/package IDs. Configure the bundled web output directory; do not ship a development server URL. Build iOS with supported macOS/Xcode tooling and Android with the supported Android Studio/JDK/SDK combination.
3. Add an environment-aware API base URL. The current `/api/ai-rota` relative route points to a Netlify origin in the web app, but will point to a local native origin in a bundled app. Use the owner's HTTPS API endpoint in native builds, configure narrow CORS/origin handling and preserve bearer-token verification. Never ship the OpenAI secret.
4. Implement native session persistence using an appropriately reviewed secure storage adapter. Test first use, app restart, OS process termination, reinstall, device linking and recovery. A browser's localStorage is not a reliable migration mechanism for existing accounts. Provide a clear web-to-mobile link/recovery journey.
5. Handle circle invitations and plan links using Universal Links/App Links, owner-controlled domain association files and verified routes. Handle cold and warm launch. Ensure links don't expose recovery secrets or bypass membership checks.
6. Integrate system photo/document selection, file sharing and calendar export. Request only necessary permissions with clear purpose text. Keep screenshot extraction optional; users must review AI results. Explain that selected images are sent for external AI processing before upload. No broad photo-library access should be required just to select one image.
7. Adapt safe areas, keyboard movement, back navigation, dialogs, large text, screen reader labels and loading/offline states. Disable or adapt the web service worker in native builds so caches cannot conflict with bundled releases. Never label stale data as current confirmed freedom.
8. Add complete account deletion and shared-content safety/support flows. Consider plan reminders/push only as an explicitly agreed feature; push tokens, consent, APNs/FCM and reminder scheduling do not exist in this handover.
9. Validate real devices and accessibility, then create TestFlight and Play testing releases. Supply review access using fictional data and reliable backend availability. Resolve review feedback and deliver signed release artifacts plus reproducible source.

## Account deletion is unfinished

Existing device unlinking, circle deletion or an activity label saying account_deactivated does not establish complete account deletion. The developer must trace actual behavior and implement a clear deletion operation covering Auth identity, device mappings, personal schedules, preferences, recovery material and applicable uploaded content. Define whether shared plan contributions are removed or anonymized, which records require retention and when backups expire. Protect against deleting another person's account and handle last-circle-admin transfer.

Apple requires in-app account deletion initiation when account creation is supported. https://developer.apple.com/support/offering-account-deletion-in-your-app/

Google's account-deletion policy requires the applicable in-app path and an accessible external web request route, with the link supplied in Data safety. The page must identify the app/developer and explain retained data. https://support.google.com/googleplay/android-developer/answer/13327111?hl=en

## Owner and developer checklist

### Accounts and signing

- [ ] Owner selects individual or organization enrollment and controls the Apple Developer and Google Play accounts, legal identity and billing.
- [ ] Complete applicable identity/organization verification, agreements and regional trader declarations in each console.
- [ ] Owner approves final app name, bundle ID, Android package name, supported regions and age audience.
- [ ] Invite the developer using app-specific roles, not the owner's password. Owner retains final release authority.
- [ ] Configure Apple distribution signing/provisioning and App Store Connect access; retain certificates in owner-controlled systems.
- [ ] Configure Android Play App Signing and protect the upload key/keystore. Document owner-controlled backup and recovery. Never include signing keys in a general ZIP.
- [ ] Pin build tools and record exact Xcode/iOS SDK, Android SDK/JDK and Capacitor versions in CI.

### Privacy and content

- [ ] Publish accurate privacy, support and account-deletion pages under an owner-controlled domain.
- [ ] Inventory actual data flows: profile names/handles, schedules, circle membership, plans/notes/votes, device identifiers/sessions, uploaded images, AI provider processing and infrastructure logs. Validate retention with the owner/providers; do not assume zero retention.
- [ ] Complete Apple's App Privacy answers and Google's Data safety using actual collection/sharing behavior, including SDKs. Do not declare “no data collected” for this connected app.
- [ ] Add iOS privacy manifests/required-reason declarations and appropriate usage descriptions for the native code and SDKs actually used. https://developer.apple.com/documentation/bundleresources/privacy-manifest-files
- [ ] Do not enable analytics or tracking by default as part of conversion. Existing PostHog configuration was not exported or changed. Inspect actual integrations before completing disclosures.
- [ ] Provide reporting, blocking and a response process for user-generated shared notes/suggestions where required. Private-circle membership alone does not establish moderation compliance.
- [ ] If adding third-party social login, assess Apple's equivalent-login requirements. Current anonymous/device linking does not establish that social login is present.

Apple privacy guidance: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy . Google Data safety and deletion guidance: https://support.google.com/googleplay/android-developer/answer/13327111?hl=en . These checklists are implementation planning, not a legal-compliance certification.

### Store assets and submission

- [ ] Final icon assets in the platform-required sizes; current web icons are reference assets and may need higher-resolution artwork.
- [ ] Screenshots captured from the real native builds in the sizes/form factors requested by the consoles; use fictional people and schedules.
- [ ] Google feature graphic and any requested promotional assets; Apple previews if desired. No approved store screenshots are included here.
- [ ] App title, subtitle/short description, full description, keywords/category, support contact, copyright and release notes approved by owner.
- [ ] Complete content/age ratings, ads declaration, app access instructions, export-compliance/encryption questions and any applicable permission declarations.
- [ ] Reviewers receive a reliable demo account or full demo mode with fictional circle schedules, an invitation path and instructions for AI import without real personal data.
- [ ] Verify the current Apple submission SDK/tool requirements at https://developer.apple.com/news/upcoming-requirements/ .
- [ ] Google's currently documented requirement for ordinary new apps/updates is Android 16/API 36 or higher; verify the deadline and any applicable exception directly at submission. https://developer.android.com/google/play/requirements/target-sdk
- [ ] For personal Play developer accounts created after 13 November 2023, complete the required closed test with at least 12 continuously opted-in testers for 14 days, then apply for production access. Account type can change which requirements apply. https://support.google.com/googleplay/android-developer/answer/14151465?hl=en
- [ ] Complete TestFlight/internal/closed testing, submit signed iOS build and Android App Bundle, address review feedback and use a controlled rollout. No approval date can be promised.

## Developer deliverables and acceptance criteria

| Milestone | Required evidence |
|---|---|
| Reproducible baseline | Fresh checkout builds using pinned dependencies; development setup works without any production secret or user export |
| Native foundations | Both projects build; app launches on supported iOS and Android devices with correct safe areas and navigation |
| Account continuity | Existing web member links to mobile without duplicate schedules; restart/reinstall/recovery scenarios documented |
| Scheduling parity | Unknown stays unknown; manual entries survive imports; night recovery and buffers agree across all availability views; Working time default and simple labels remain |
| Access boundaries | Anonymous/unlinked/pending/outsider/member/viewer/admin cases exercise direct API and RPC calls; private shifts/notes never leak |
| Full product journey | Create/join circle → enter/import rota → find overlap → create plan → RSVP/vote/note works on both platforms |
| Native integrations | Selected image/document import, deep links and calendar/share output work on physical devices with denial/retry cases |
| Account deletion | In-app and web-request paths work, deletion scope/retention is documented and existing sessions cannot retain unauthorized access |
| Release readiness | Signed owner-controlled builds, accurate disclosures, listings, real native screenshots and reviewer access supplied |
| Handover | Source, migrations, CI instructions, credential ownership, incident/rollback instructions and remaining issue list delivered |

Do not accept a deliverable that only displays the production website in a WebView, loses existing accounts, puts server secrets in an APK/IPA, changes availability rules, or cannot be rebuilt by the owner. Any optional subscriptions/payments should be a separate agreed scope with current store billing rules reviewed before implementation.
