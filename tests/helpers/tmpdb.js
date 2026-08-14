// Imported FIRST by every test file: ESM evaluates imports in order, so this
// runs before db.js reads its configuration.
//
// The database is PGlite — Postgres 17 compiled to WASM, in-process and
// in-memory. Node runs each test file in its own process, so every suite gets a
// private, empty Postgres with no server to start and nothing to clean up. The
// tests therefore exercise the real dialect: the same schema.sql that is applied
// to Supabase, with the same types and the same constraints.
//
// DATABASE_URL is cleared explicitly — if the machine exports one, the suite
// would otherwise connect to a real project and start writing to it.
delete process.env.DATABASE_URL;
delete process.env.W2B_DATABASE_URL;
delete process.env.W2B_PGLITE_DIR;

// A stray TELEGRAM_BOT_TOKEN in the machine environment would put the tests in
// LIVE mode and hit the real Telegram API.
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.ADMIN_TG_IDS = '';
process.env.W2B_DISABLE_SCHEDULER = '1';
process.env.VERCEL = '';
