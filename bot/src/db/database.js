import Database from "better-sqlite3";
import { config } from "../config.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS lotteries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_id TEXT,
    total_numbers INTEGER NOT NULL,
    price INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RUB',
    status TEXT NOT NULL DEFAULT 'open', -- open | closed
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lottery_id INTEGER NOT NULL,
    number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'free', -- free | booked | paid
    booked_by TEXT,
    booked_by_name TEXT,
    booked_at INTEGER,
    payment_id TEXT,
    paid_at INTEGER,
    FOREIGN KEY (lottery_id) REFERENCES lotteries(id) ON DELETE CASCADE,
    UNIQUE(lottery_id, number)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lottery_id INTEGER NOT NULL,
    number_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_payment_id TEXT,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RUB',
    status TEXT NOT NULL DEFAULT 'pending', -- pending | succeeded | failed | canceled
    sbp_url TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (lottery_id) REFERENCES lotteries(id) ON DELETE CASCADE,
    FOREIGN KEY (number_id) REFERENCES numbers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_numbers_lottery ON numbers(lottery_id, status);
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_payments_provider ON payments(provider_payment_id);
`);

export default db;
