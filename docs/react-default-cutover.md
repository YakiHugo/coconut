# React application entry

`reader/index.html` is the application at `/` and `/index.html`. React owns discovery, library, reading, player, AI/tasks, recovery and native controls. There is no alternate legacy renderer or preview document. Startup failures stay in the React recovery view; they do not redirect to an older interface.

## Shared modules

The entry retains the pure domain and persistence modules it actually uses: client capabilities, summary validation, document core, passages/playback, task client, library save pipeline, IndexedDB adapter, canonical library and storage provider. Removing the former DOM interface does not authorize clearing user data, relaxing source validation or presenting queued writes as saved.

## Evidence boundaries

- `test:react`, the source-first browser suite, production matrix and palette suite exercise the default application.
- The production matrix uses authored content with real Node/SQLite persistence. Model and browser-native receipts are explicitly simulated where indicated.
- The actual packaged macOS suite runs the default React entry, real menu commands/file choosers, durable notes/backups, remembered media and close/restart recovery. Native keep-editing dialog responses are authored.
- Public source/helper transport checks establish their specific backend behavior. They do not establish live inference quality or every platform-to-React journey.
- The default HTML dependency graph is checked during building and packaging. Native bridge access is restricted to the trusted root/index document.

## Change acceptance

Every change still requires independent review and final exact-head CI, including the default browser and actual packaged lifecycle suites. The migration baseline `c2db14c7d30db00c47b3461608f329b514cb8f93` passed those gates. That result does not substitute for the final legacy-removal commit's CI.

No user storage is deleted by removing the legacy frontend. Existing recovery/export controls remain available in React. A local ASR executor is optional and explicitly configured; frontend cleanup does not install or download models.
