# FlightDrama — Aviation Content OS TODO

## Phase 1: Copy source files from cloned repo
- [x] Copy drizzle/schema.ts
- [x] Copy server files (db.ts, routers.ts, all feature modules)
- [x] Copy client files (App.tsx, all pages, components)
- [x] Copy shared files
- [x] Copy config files (package.json extras, vite.config, etc.)

## Phase 2: Dependencies & Build
- [x] Install extra dependencies (rss-parser, cheerio, node-html-parser, @napi-rs/canvas, react-markdown, etc.)
- [x] Apply database migrations
- [x] Verify dev server builds without errors

## Phase 3: Secrets & Scheduled Jobs
- [x] Configure APP_PASSWORD secret
- [x] Configure PEXELS_API_KEY secret
- [x] Configure OPENAI_API_KEY_CUSTOM secret
- [x] Configure OPENAI_API_URL_CUSTOM secret
- [x] Configure INSTAGRAM_ACCESS_TOKEN secret (skipped — not used)
- [x] Set up heartbeat scheduled jobs (rss-ingest, weekly-digest, scoring-learn)

## Phase 4: Tests & Publish
- [x] Run vitest tests (20/20 passed)
- [x] Save checkpoint
- [x] Publish (ready — click Publish button in Management UI)
