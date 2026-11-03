# Repository cleanup (2 November 2026)

Based on the previously authentication-hardened repository.

Removed the third-party runtime script from `frontend/public/index.html`, the optional vendor visual-editing CRACO wrapper and dependency, vendor-specific test metadata, obsolete generated test reports, agent configuration, and unused home test ID constant. Existing backend routes, database schema, and operational UI components were retained.

The vendor dependency was removed from both `frontend/package.json` and the root package-lock entries. A full npm dependency resolution could not run offline; validate `npm ci` in your deployment environment.

No live production deployment or end-to-end integration testing was performed. Validate login, cookies, job pages, documents, notifications and permissions in a preview deployment before production rollout.
