# Package verification

28 September 2026

- Fourteen source files matched byte-for-byte with the archived package published as Netlify deployment 6ab8323f2c4a38a1b376e2da. The public configuration file was deliberately excluded from equality checking because its project URL/key were replaced with placeholders.
- Existing tests are included as source; they were not rerun during this handover task.
- The production migration history and 30-table/118-function public schema inventory were retrieved read-only. No customer rows or Auth users were requested or exported.
- Public keys and project-specific environment values were removed from the copied configuration. No local Netlify login, OpenAI secret, recovery material, private signing file or actual environment file was copied.
- Pattern inspection found no actual API credential or personal email in the package. Source occurrences of `data-ask-date` are UI attributes, not secret keys.
- The generated current-schema SQL is supplied for review and development restoration; it has not been executed or certified as a complete project backup. No production or staging mutation occurred in this task.
- No native binary, signing profile or store approval is included. These remain developer deliverables.

`MANIFEST-SHA256.json` records checksums of all delivered files except the manifest itself. The ZIP checksum is delivered separately.
