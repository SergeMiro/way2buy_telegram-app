// Imported FIRST by every test file: ESM evaluates imports in order, so this
// runs before db.js reads W2B_DB_PATH. Each run gets a private database file
// and a guaranteed-empty bot token (a stray TELEGRAM_BOT_TOKEN in the machine
// environment would otherwise put the tests in LIVE mode and hit Telegram).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.W2B_DB_PATH = join(mkdtempSync(join(tmpdir(), 'w2b-test-')), 'test.db');
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.ADMIN_TG_IDS = '';
process.env.W2B_DISABLE_SCHEDULER = '1';
process.env.VERCEL = '';
