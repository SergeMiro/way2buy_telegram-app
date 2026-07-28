// ─────────────────────────────────────────────────────────────────────────
//  env.js — must be the FIRST import of the process.
//
//  `override: true` is deliberate: this machine may already export an unrelated
//  TELEGRAM_BOT_TOKEN (another bot). Without the override the app would boot in
//  LIVE mode with a foreign token and try to post into the Way2Buy channels.
//  The project's own .env is the single source of truth; an absent .env leaves
//  the process env untouched, so hosting-provider variables still work.
// ─────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';

dotenv.config({ override: true, quiet: true });
