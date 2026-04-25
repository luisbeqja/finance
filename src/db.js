import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

// --- Schema init (call once at startup) ---

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT PRIMARY KEY,
      actual_server_url TEXT,
      actual_password TEXT,
      actual_budget_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_bank_accounts (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
      bank_name TEXT NOT NULL,
      bank_display_name TEXT,
      bank_country TEXT,
      enablebanking_session_id TEXT,
      enablebanking_account_id TEXT,
      actual_account_id TEXT,
      last_sync_date TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (chat_id, bank_name)
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      used_by TEXT,
      used_at TIMESTAMPTZ
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Europe/Rome';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS insights_enabled BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_insight_date TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_weekly_insight_date TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_monthly_insight_date TEXT;
  `);

  await migrateLegacyBankColumns();
}

/**
 * Migrates the pre-multi-bank schema (single Intesa session stored on the
 * users row) into the new user_bank_accounts table. Idempotent: only runs
 * when the legacy columns are still present on `users`.
 */
async function migrateLegacyBankColumns() {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'users'
       AND column_name IN ('enablebanking_session_id', 'enablebanking_account_id', 'actual_account_id', 'last_sync_date')`
  );
  if (rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO user_bank_accounts (
        chat_id, bank_name, bank_display_name, bank_country,
        enablebanking_session_id, enablebanking_account_id,
        actual_account_id, last_sync_date
      )
      SELECT chat_id, 'intesa', 'Intesa Sanpaolo', 'IT',
             enablebanking_session_id, enablebanking_account_id,
             actual_account_id, last_sync_date
      FROM users
      WHERE enablebanking_session_id IS NOT NULL
      ON CONFLICT (chat_id, bank_name) DO NOTHING
    `);
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS enablebanking_session_id`);
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS enablebanking_account_id`);
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS actual_account_id`);
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS last_sync_date`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --- Encryption (AES-256-GCM) ---
// Key derived from TELEGRAM_BOT_TOKEN — protects data at rest in case
// the .db file is leaked without the .env file.

const SENSITIVE_FIELDS = ["actual_password", "enablebanking_session_id"];
const SALT = "actualintesa-v1";

let encryptionKey = null;

function getKey() {
  if (encryptionKey) return encryptionKey;
  const secret = process.env.TELEGRAM_BOT_TOKEN;
  if (!secret) throw new Error("TELEGRAM_BOT_TOKEN required for database encryption");
  encryptionKey = crypto.pbkdf2Sync(secret, SALT, 100_000, 32, "sha256");
  return encryptionKey;
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(stored) {
  if (!stored) return null;
  const parts = stored.split(":");
  if (parts.length !== 3) return stored; // not encrypted (legacy plaintext)
  const [ivHex, tagHex, dataHex] = parts;
  try {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const data = Buffer.from(dataHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(data) + decipher.final("utf8");
  } catch {
    return stored; // decryption failed — return as-is (legacy plaintext)
  }
}

function encryptFields(data) {
  const out = { ...data };
  for (const field of SENSITIVE_FIELDS) {
    if (field in out && out[field]) {
      out[field] = encrypt(out[field]);
    }
  }
  return out;
}

function decryptFields(row) {
  if (!row) return row;
  const out = { ...row };
  for (const field of SENSITIVE_FIELDS) {
    if (out[field]) {
      out[field] = decrypt(out[field]);
    }
  }
  return out;
}

// --- User functions ---

const USER_COLUMNS = [
  "chat_id",
  "actual_server_url",
  "actual_password",
  "actual_budget_id",
  "timezone",
  "insights_enabled",
  "last_daily_insight_date",
  "last_weekly_insight_date",
  "last_monthly_insight_date",
];

/**
 * Get a user by Telegram chat ID with their connected bank accounts attached
 * as `bankAccounts`. Sensitive fields are decrypted.
 */
export async function getUser(chatId) {
  const { rows } = await pool.query("SELECT * FROM users WHERE chat_id = $1", [String(chatId)]);
  const user = decryptFields(rows[0]);
  if (!user) return undefined;
  user.bankAccounts = await listBankAccounts(chatId);
  return user;
}

/**
 * Save (upsert) a user's Actual Budget configuration. Bank accounts live in
 * a separate table — use saveBankAccount() for those.
 */
export async function saveUser(chatId, data) {
  const allowed = USER_COLUMNS.filter((c) => c !== "chat_id" && c in data);
  const encrypted = encryptFields(data);

  const { rows } = await pool.query("SELECT 1 FROM users WHERE chat_id = $1", [String(chatId)]);
  if (rows.length > 0) {
    if (allowed.length === 0) return;
    const setClause = allowed.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const values = [String(chatId), ...allowed.map((f) => encrypted[f] ?? null)];
    await pool.query(`UPDATE users SET ${setClause} WHERE chat_id = $1`, values);
  } else {
    const columns = ["chat_id", ...allowed];
    const values = [String(chatId), ...allowed.map((f) => encrypted[f] ?? null)];
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    await pool.query(
      `INSERT INTO users (${columns.join(", ")}) VALUES (${placeholders})`,
      values
    );
  }
}

/** Update specific fields on the users row (encrypts sensitive fields). */
export async function updateUser(chatId, data) {
  const allowed = USER_COLUMNS.filter((c) => c !== "chat_id" && c in data);
  if (allowed.length === 0) return;
  const encrypted = encryptFields(data);
  const setClause = allowed.map((f, i) => `${f} = $${i + 2}`).join(", ");
  const values = [String(chatId), ...allowed.map((f) => encrypted[f] ?? null)];
  await pool.query(`UPDATE users SET ${setClause} WHERE chat_id = $1`, values);
}

/** Delete a user (cascades to user_bank_accounts). */
export async function deleteUser(chatId) {
  const result = await pool.query("DELETE FROM users WHERE chat_id = $1", [String(chatId)]);
  return result.rowCount > 0;
}

// --- Bank account functions ---

/** List all connected bank accounts for a user (decrypted). */
export async function listBankAccounts(chatId) {
  const { rows } = await pool.query(
    "SELECT * FROM user_bank_accounts WHERE chat_id = $1 ORDER BY id",
    [String(chatId)]
  );
  return rows.map((r) => decryptFields(r));
}

/** Get a specific bank account row for a user. */
export async function getBankAccount(chatId, bankName) {
  const { rows } = await pool.query(
    "SELECT * FROM user_bank_accounts WHERE chat_id = $1 AND bank_name = $2",
    [String(chatId), bankName]
  );
  return decryptFields(rows[0]);
}

/**
 * Upsert a bank account row (encrypts sensitive fields). Identified by
 * (chat_id, bank_name) — connecting the same bank again replaces the
 * existing session for that bank.
 */
export async function saveBankAccount(chatId, bankName, data) {
  const encrypted = encryptFields(data);
  const fields = [
    "bank_display_name",
    "bank_country",
    "enablebanking_session_id",
    "enablebanking_account_id",
    "actual_account_id",
    "last_sync_date",
  ];

  const updates = fields.filter((f) => f in encrypted);
  if (updates.length === 0) return;

  const setClause = updates.map((f, i) => `${f} = EXCLUDED.${f}`).join(", ");
  const insertCols = ["chat_id", "bank_name", ...updates];
  const insertVals = [String(chatId), bankName, ...updates.map((f) => encrypted[f] ?? null)];
  const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(", ");

  await pool.query(
    `INSERT INTO user_bank_accounts (${insertCols.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT (chat_id, bank_name)
     DO UPDATE SET ${setClause}`,
    insertVals
  );
}

/** Update a single field (e.g. last_sync_date) on a bank account row. */
export async function updateBankAccount(chatId, bankName, data) {
  const encrypted = encryptFields(data);
  const fields = Object.keys(encrypted);
  if (fields.length === 0) return;
  const setClause = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const values = [String(chatId), bankName, ...fields.map((f) => encrypted[f] ?? null)];
  await pool.query(
    `UPDATE user_bank_accounts SET ${setClause}
     WHERE chat_id = $1 AND bank_name = $2`,
    values
  );
}

/** Delete a connected bank for a user. Returns true if a row was removed. */
export async function deleteBankAccount(chatId, bankName) {
  const result = await pool.query(
    "DELETE FROM user_bank_accounts WHERE chat_id = $1 AND bank_name = $2",
    [String(chatId), bankName]
  );
  return result.rowCount > 0;
}

// --- Invite codes ---

export async function createInviteCode() {
  const code = crypto.randomBytes(4).toString("hex");
  await pool.query("INSERT INTO invite_codes (code) VALUES ($1)", [code]);
  return code;
}

export async function useInviteCode(code, chatId) {
  const { rows } = await pool.query("SELECT * FROM invite_codes WHERE code = $1", [code]);
  if (rows.length === 0 || rows[0].used_by) return false;
  await pool.query(
    "UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = $2",
    [String(chatId), code]
  );
  return true;
}

export async function listUsers() {
  const { rows } = await pool.query(`
    SELECT u.chat_id, u.created_at,
           (SELECT MAX(last_sync_date) FROM user_bank_accounts b WHERE b.chat_id = u.chat_id) AS last_sync_date,
           (SELECT COUNT(*) FROM user_bank_accounts b WHERE b.chat_id = u.chat_id) AS bank_count
    FROM users u
  `);
  return rows;
}

/**
 * Returns all users with insights_enabled = TRUE, decrypted, with bankAccounts attached.
 * Used by the insight scheduler.
 */
export async function listInsightUsers() {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE insights_enabled = TRUE"
  );
  const users = [];
  for (const row of rows) {
    const user = decryptFields(row);
    user.bankAccounts = await listBankAccounts(user.chat_id);
    users.push(user);
  }
  return users;
}
