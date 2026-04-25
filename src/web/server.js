import "dotenv/config";
import express from "express";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { initDb, getUser, deleteBankAccount, updateBankAccount, saveBankAccount } from "../db.js";
import { withActual } from "../bot/actual-query.js";
import { askAgent, clearHistory } from "../agent/index.js";
import { getTransactions, startAuth, createSession, getSession } from "../enablebanking.js";
import { mapTransaction } from "../sync.js";
import { importTransactions, validateConnection } from "../actual.js";
import { listSupportedBanks, getBankConfig, resolveBank } from "../banks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (process.env.ENABLEBANKING_KEY_CONTENT && !process.env.ENABLEBANKING_KEY_PATH) {
  const keyPath = join(tmpdir(), "enablebanking-key.pem");
  writeFileSync(keyPath, process.env.ENABLEBANKING_KEY_CONTENT, "utf-8");
  process.env.ENABLEBANKING_KEY_PATH = keyPath;
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

function requireUser(handler) {
  return async (req, res) => {
    const chatId = req.params.chatId;
    if (!chatId) return res.status(400).json({ error: "Missing chatId" });
    const user = await getUser(chatId);
    if (!user) return res.status(404).json({ error: "User not found. Set up via Telegram first using /setup." });
    if (!user.actual_server_url) {
      return res.status(400).json({ error: "Actual Budget not configured. Run /setup in Telegram first." });
    }
    req.user = user;
    return handler(req, res);
  };
}

async function syncBankAccount(user, bank) {
  const appId = process.env.ENABLEBANKING_APP_ID;
  const keyPath = process.env.ENABLEBANKING_KEY_PATH;

  let dateFrom;
  if (bank.last_sync_date) {
    dateFrom = bank.last_sync_date;
  } else {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    dateFrom = ninetyDaysAgo.toISOString().split("T")[0];
  }
  const dateTo = new Date().toISOString().split("T")[0];

  const transactions = await getTransactions(
    appId, keyPath, bank.enablebanking_account_id, dateFrom, dateTo
  );
  const mapped = transactions.map(mapTransaction);

  const result = await importTransactions(
    user.actual_server_url,
    user.actual_password,
    user.actual_budget_id,
    bank.actual_account_id,
    mapped
  );

  await updateBankAccount(user.chat_id, bank.bank_name, { last_sync_date: dateTo });

  const fetched = transactions.length;
  const imported = result.added?.length || 0;
  const updated = result.updated?.length || 0;
  const errors = result.errors?.length || 0;
  return { fetched, imported, updated, skipped: fetched - imported - updated, errors };
}

app.get("/api/user/:chatId", async (req, res) => {
  const user = await getUser(req.params.chatId);
  if (!user) return res.status(404).json({ error: "User not found. Set up via Telegram first using /setup." });
  res.json({
    chat_id: user.chat_id,
    actual_server_url: user.actual_server_url,
    actual_budget_id: user.actual_budget_id,
    has_password: Boolean(user.actual_password),
    bankAccounts: (user.bankAccounts || []).map((b) => ({
      bank_name: b.bank_name,
      bank_display_name: b.bank_display_name,
      bank_country: b.bank_country,
      last_sync_date: b.last_sync_date,
    })),
  });
});

app.get("/api/balance/:chatId", requireUser(async (req, res) => {
  const accounts = await withActual(req.user, async (api) => {
    const allAccounts = await api.getAccounts();
    const open = allAccounts.filter((a) => !a.closed);
    const results = [];
    for (const acc of open) {
      const balance = await api.getAccountBalance(acc.id);
      results.push({
        name: acc.name,
        balance,
        onBudget: acc.offbudget === 0 || acc.offbudget === false,
      });
    }
    return results;
  });
  res.json({ accounts });
}));

app.get("/api/transactions/:chatId", requireUser(async (req, res) => {
  let count = parseInt(req.query.count, 10);
  if (!count || count < 1) count = 10;
  if (count > 100) count = 100;

  const data = await withActual(req.user, async (api) => {
    const accounts = await api.getAccounts();
    const open = accounts.filter((a) => !a.closed);
    const accountMap = new Map(open.map((a) => [a.id, a.name]));

    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const allTx = [];
    for (const acc of open) {
      const txs = await api.getTransactions(acc.id, startDate, endDate);
      allTx.push(...txs);
    }

    const payees = await api.getPayees();
    const categories = await api.getCategories();
    return { transactions: allTx, payees, categories, accountMap };
  });

  const payeeMap = new Map(data.payees.map((p) => [p.id, p.name]));
  const categoryMap = new Map(data.categories.map((c) => [c.id, c.name]));

  const sorted = data.transactions
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
    .slice(0, count)
    .map((tx) => ({
      date: tx.date,
      amount: tx.amount,
      payee: payeeMap.get(tx.payee) || "(unknown)",
      category: categoryMap.get(tx.category) || "",
      account: data.accountMap.get(tx.account) || "",
      notes: tx.notes || "",
    }));

  res.json({ transactions: sorted });
}));

app.get("/api/spending/:chatId", requireUser(async (req, res) => {
  let month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    const now = new Date();
    month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  const result = await withActual(req.user, async (api) => api.getBudgetMonth(month));

  let income = 0;
  let spent = 0;
  const groups = [];

  for (const group of result.categoryGroups || []) {
    const cats = [];
    for (const cat of group.categories || []) {
      const catSpent = cat.spent || 0;
      if (catSpent !== 0) {
        cats.push({ name: cat.name, spent: catSpent });
      }
      income += cat.received || 0;
      spent += catSpent;
    }
    cats.sort((a, b) => Math.abs(b.spent) - Math.abs(a.spent));
    if (cats.length > 0) {
      groups.push({ name: group.name, categories: cats });
    }
  }

  res.json({ month, income, spent, groups });
}));

app.post("/api/sync/:chatId", requireUser(async (req, res) => {
  const banks = req.user.bankAccounts || [];
  if (banks.length === 0) {
    return res.status(400).json({ error: "No banks connected. Connect a bank in Telegram with /connectbank." });
  }

  const startTime = Date.now();
  const results = [];
  for (const bank of banks) {
    const displayName = bank.bank_display_name || bank.bank_name;
    try {
      const r = await syncBankAccount(req.user, bank);
      results.push({ displayName, ...r });
    } catch (err) {
      results.push({ displayName, error: err.message });
    }
  }
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
  res.json({ banks: results, totalDuration });
}));

app.post("/api/chat/:chatId", requireUser(async (req, res) => {
  const question = (req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "Empty question" });
  const answer = await askAgent(req.user, question);
  res.json({ answer });
}));

app.post("/api/chat/:chatId/clear", requireUser(async (req, res) => {
  clearHistory(req.user.chat_id);
  res.json({ ok: true });
}));

app.delete("/api/banks/:chatId/:bankName", requireUser(async (req, res) => {
  const removed = await deleteBankAccount(req.user.chat_id, req.params.bankName.toLowerCase());
  if (!removed) return res.status(404).json({ error: "Bank not found" });
  res.json({ ok: true });
}));

// --- Bank connection flow ---
const REDIRECT_URL = "https://enablebanking.com";
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingConnections = new Map();

function setPending(chatId, state) {
  pendingConnections.set(String(chatId), { ...state, ts: Date.now() });
}
function getPending(chatId) {
  const s = pendingConnections.get(String(chatId));
  if (!s) return null;
  if (Date.now() - s.ts > PENDING_TTL_MS) {
    pendingConnections.delete(String(chatId));
    return null;
  }
  return s;
}
function clearPending(chatId) {
  pendingConnections.delete(String(chatId));
}

app.get("/api/connect/banks", (_req, res) => {
  res.json({
    banks: listSupportedBanks().map((b) => ({ key: b.key, displayName: b.displayName })),
  });
});

app.post("/api/connect/:chatId/start", requireUser(async (req, res) => {
  const bankKey = (req.body?.bankKey || "").toLowerCase();
  let bankConfig;
  try {
    bankConfig = getBankConfig(bankKey);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const appId = process.env.ENABLEBANKING_APP_ID;
  const keyPath = process.env.ENABLEBANKING_KEY_PATH;
  if (!appId || !keyPath) {
    return res.status(400).json({ error: "Enable Banking is not configured (missing ENABLEBANKING_APP_ID or key)" });
  }

  const aspsp = await resolveBank(appId, keyPath, bankKey);
  const auth = await startAuth(appId, keyPath, aspsp.name, aspsp.country, REDIRECT_URL);

  setPending(req.user.chat_id, {
    step: "awaiting_code",
    bankKey,
    bankDisplayName: bankConfig.displayName,
    aspsp,
  });

  res.json({ authUrl: auth.url, bankDisplayName: bankConfig.displayName });
}));

app.post("/api/connect/:chatId/code", requireUser(async (req, res) => {
  const pending = getPending(req.user.chat_id);
  if (!pending || pending.step !== "awaiting_code") {
    return res.status(400).json({ error: "No pending connection. Start over." });
  }

  const text = String(req.body?.redirectUrl || "").trim();
  let code;
  try {
    code = new URL(text).searchParams.get("code");
  } catch {
    code = text;
  }
  if (!code) return res.status(400).json({ error: "Could not extract authorization code" });

  const appId = process.env.ENABLEBANKING_APP_ID;
  const keyPath = process.env.ENABLEBANKING_KEY_PATH;

  const session = await createSession(appId, keyPath, code);
  let accounts = session.accounts || [];

  if (accounts.length === 0 && session.session_id) {
    try {
      const detail = await getSession(appId, keyPath, session.session_id);
      accounts = detail.accounts || [];
    } catch (_) {}
  }

  if (accounts.length === 0) {
    clearPending(req.user.chat_id);
    return res.status(400).json({
      error: "No bank accounts returned. Re-authorize and tick the account(s) you want to share.",
    });
  }

  setPending(req.user.chat_id, {
    ...pending,
    step: "awaiting_account",
    bankSessionId: session.session_id,
    bankAccounts: accounts,
  });

  res.json({
    accounts: accounts.map((a) => ({
      uid: a.uid,
      label: a.account_id?.iban || a.uid,
    })),
  });
}));

app.post("/api/connect/:chatId/finish", requireUser(async (req, res) => {
  const pending = getPending(req.user.chat_id);
  if (!pending || pending.step !== "awaiting_account") {
    return res.status(400).json({ error: "No pending connection ready to finish" });
  }

  const { bankAccountUid, actualAccountId } = req.body || {};
  if (!bankAccountUid || !actualAccountId) {
    return res.status(400).json({ error: "Missing bankAccountUid or actualAccountId" });
  }

  const matched = pending.bankAccounts.find((a) => a.uid === bankAccountUid);
  if (!matched) return res.status(400).json({ error: "Invalid bank account" });

  try {
    await validateConnection(
      req.user.actual_server_url,
      req.user.actual_password,
      req.user.actual_budget_id,
      actualAccountId
    );
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const bankConfig = getBankConfig(pending.bankKey);
  await saveBankAccount(req.user.chat_id, bankConfig.key, {
    bank_display_name: bankConfig.displayName,
    bank_country: pending.aspsp.country,
    enablebanking_session_id: pending.bankSessionId,
    enablebanking_account_id: bankAccountUid,
    actual_account_id: actualAccountId,
    last_sync_date: null,
  });

  clearPending(req.user.chat_id);
  res.json({ ok: true, displayName: bankConfig.displayName });
}));

app.post("/api/connect/:chatId/cancel", requireUser(async (req, res) => {
  clearPending(req.user.chat_id);
  res.json({ ok: true });
}));

app.use((err, req, res, _next) => {
  console.error("[web] Error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.WEB_PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, "127.0.0.1", () => {
      console.log(`Finance web UI running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
