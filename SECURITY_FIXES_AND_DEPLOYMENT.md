# PRG Job Portal — authentication hardening

## Changes in this repository

- Removed automatic `seed_data()` invocation from FastAPI lifespan. Vercel cold starts no longer overwrite the administrator password, role or name, create demo users, or insert demo records.
- Existing-user branch of legacy `seed_data()` no longer resets passwords or changes roles. This function is not called by the application.
- Removed writing plaintext credentials to `/tmp/test_credentials.md`.
- Fixed expired login lockouts and expired failure windows; failed attempts now increment atomically in PostgreSQL. A lockout returns `Retry-After`.
- Supabase authentication failures are classified: bad credentials yield 401, Supabase rate limits yield 429, and upstream errors yield 503 without incrementing failed-password counters.
- Login no longer duplicates the access token in JSON; the existing HttpOnly cookie session remains.
- Session cookies use `SameSite=Lax` because frontend and API share an origin.
- Password reset links are no longer written to application logs.
- Invalid JWT key lookup errors return 401 instead of a server exception.

## Deployment instructions (existing production database)

1. Back up the existing Supabase database and record current Vercel environment variable **names** (do not copy secret values into git).
2. Deploy the repository as the existing Vercel project, using `frontend` as the Root Directory if that is how the project is currently configured.
3. Retain `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL` and any existing optional integration variables. All four mandatory values must correspond to the same Supabase project. `SUPABASE_SECRET_KEY` must be a server-only secret.
4. `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_NAME` are no longer needed at runtime. You may remove them from Vercel **after** deploying this build. Do not expose or commit their values.
5. Check the correct production domain under `FRONTEND_URL` and/or `CORS_ORIGINS`. The browser's login requests use the relative `/api` endpoint.
6. If the original startup routine changed your password, reset it once using Supabase Auth admin controls or the application's password-reset flow after deployment. Existing passwords cannot be recovered from hashes.
7. Allow the current 15-minute lockout to expire before testing. Verify a successful `POST /api/auth/login` and subsequent `GET /api/auth/me` returning 200.
8. Test email invitations, reset emails, file uploads, notifications and key role-based pages before considering the release complete.

## Limitations / further work

- This patch is a targeted security and authentication repair, not a full independent penetration test or end-to-end acceptance test.
- The legacy seed function remains in the source as inactive code to avoid inadvertently changing business-data generation logic. Do not call it on production.
- JWKS verification requires Supabase asymmetric JWT signing keys and the correct JWKS URL. Legacy HS256 projects need a separate, carefully configured verification approach.
- Live Supabase/Vercel integration tests require access to your deployed services and are not run here.
- This release does not run any SQL migrations or modify existing production data.
