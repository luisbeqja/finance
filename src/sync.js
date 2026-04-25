import { getTransactions } from "./enablebanking.js";
import { importTransactions } from "./actual.js";
import { updateBankAccount } from "./db.js";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import ora from "ora";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const envPath = join(projectRoot, ".env");

/**
 * Updates or adds a value to .env file
 * @param {string} key - Environment variable key
 * @param {string} value - Environment variable value
 */
export function updateEnvValue(key, value) {
  let content = "";

  if (readFileSync(envPath, "utf-8")) {
    content = readFileSync(envPath, "utf-8");
  }

  const regex = new RegExp(`^${key}=.*$`, "m");

  if (regex.test(content)) {
    // Update existing key
    content = content.replace(regex, `${key}=${value}`);
  } else {
    // Add new key
    content = content.trim() + `\n${key}=${value}\n`;
  }

  writeFileSync(envPath, content, "utf-8");
}

/**
 * Maps an Enable Banking transaction to Actual Budget format
 * @param {Object} tx - Enable Banking transaction object
 * @returns {Object} Actual Budget transaction format
 */
export function mapTransaction(tx) {
  // Date: use first available
  const date = tx.booking_date || tx.value_date || tx.transaction_date;

  // Amount: convert to cents integer with correct sign
  let amount = parseFloat(tx.transaction_amount?.amount || 0);
  amount = Math.round(amount * 100);

  // Apply sign based on credit/debit indicator
  if (tx.credit_debit_indicator === "DBIT") {
    amount = -Math.abs(amount);
  } else if (tx.credit_debit_indicator === "CRDT") {
    amount = Math.abs(amount);
  }
  // If no indicator, use the sign as-is from Enable Banking

  // Payee: creditor name for credits, debtor name for debits, fallback to remittance
  let payee_name = "";
  if (tx.credit_debit_indicator === "CRDT" && tx.creditor?.name) {
    payee_name = tx.creditor.name;
  } else if (tx.credit_debit_indicator === "DBIT" && tx.debtor?.name) {
    payee_name = tx.debtor.name;
  } else if (tx.remittance_information && tx.remittance_information.length > 0) {
    payee_name = tx.remittance_information[0];
  }

  // Notes: combine remittance info and transaction code description
  let notes = "";
  if (tx.bank_transaction_code?.description) {
    notes = tx.bank_transaction_code.description;
  }
  if (tx.remittance_information && tx.remittance_information.length > 0) {
    const remittanceText = tx.remittance_information.join(" ");
    notes = notes ? `${notes} - ${remittanceText}` : remittanceText;
  }

  // Imported ID: for duplicate detection
  const imported_id = tx.transaction_id || tx.entry_reference;

  // Cleared: booked transactions are cleared, pending are not
  const cleared = tx.status === "BOOK";

  return {
    date,
    amount,
    payee_name,
    notes,
    imported_id,
    cleared,
  };
}

/**
 * Syncs a single bank account for a user: fetch from EnableBanking,
 * map, import to Actual Budget, and update last_sync_date.
 * Used by /sync and the proactive insights scheduler.
 */
export async function syncBankAccount(user, bank) {
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
  return {
    fetched,
    imported,
    updated,
    skipped: fetched - imported - updated,
    errors,
  };
}

/**
 * Formats amount in cents as EUR string
 * @param {number} cents - Amount in cents
 * @returns {string} Formatted EUR string
 */
function formatAmount(cents) {
  const euros = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'EUR'
  }).format(euros);
}

/**
 * Runs the full transaction sync flow
 * @param {Object} options - Sync options
 * @param {boolean} options.dryRun - If true, fetch and preview without importing
 */
export async function runSync({ dryRun = false } = {}) {
  const startTime = Date.now();

  // Read config from environment
  const appId = process.env.ENABLEBANKING_APP_ID;
  const keyPath = process.env.ENABLEBANKING_KEY_PATH;
  const sessionId = process.env.ENABLEBANKING_SESSION_ID;
  const ebAccountId = process.env.ENABLEBANKING_ACCOUNT_ID;
  const serverUrl = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;
  const budgetId = process.env.ACTUAL_BUDGET_ID;
  const actualAccountId = process.env.ACTUAL_ACCOUNT_ID;

  // Determine date range
  const lastSyncDate = process.env.LAST_SYNC_DATE;
  let dateFrom;

  if (lastSyncDate) {
    dateFrom = lastSyncDate;
  } else {
    // First run: 90 days ago
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    dateFrom = ninetyDaysAgo.toISOString().split("T")[0]; // YYYY-MM-DD
  }

  const dateTo = new Date().toISOString().split("T")[0]; // Today

  if (dryRun) {
    console.log("\n[DRY RUN MODE] - No data will be imported\n");
  }

  // Step 1: Fetch transactions from Enable Banking
  const spinner = ora({
    text: `Fetching transactions from ${dateFrom} to ${dateTo}...`,
    spinner: 'dots'
  }).start();

  let transactions;
  let fetchDuration = 0;

  try {
    const fetchStart = Date.now();
    transactions = await getTransactions(appId, keyPath, ebAccountId, dateFrom, dateTo);
    fetchDuration = ((Date.now() - fetchStart) / 1000).toFixed(1);
    spinner.succeed(`Fetched ${transactions.length} transactions (${fetchDuration}s)`);
  } catch (error) {
    // Check for session/auth errors
    if (error.message.toLowerCase().includes("session") ||
        error.message.includes("401") ||
        error.message.includes("403")) {
      spinner.fail("Enable Banking session expired or invalid");
      console.error("\nRun with --setup to reconnect.");
      process.exit(1);
    }
    spinner.fail(`Failed to fetch transactions: ${error.message}`);
    throw error;
  }

  // Map transactions to Actual Budget format
  const mappedTransactions = transactions.map(mapTransaction);

  // DRY RUN: Preview and exit
  if (dryRun) {
    console.log("\nTransactions to be imported:\n");

    if (mappedTransactions.length === 0) {
      console.log("  (none)");
    } else {
      // Display preview table
      mappedTransactions.forEach(tx => {
        const amount = formatAmount(tx.amount);
        const payee = (tx.payee_name || '(unknown)').substring(0, 30);
        const notes = (tx.notes || '').substring(0, 40);
        console.log(`  ${tx.date}  ${amount.padStart(12)}  ${payee.padEnd(30)}  ${notes}`);
      });
    }

    console.log(`\n✔ Dry run: ${mappedTransactions.length} transactions would be imported`);
    return;
  }

  // Step 2: Import to Actual Budget
  let result;
  let importDuration = 0;

  const importSpinner = ora({
    text: 'Importing to Actual Budget...',
    spinner: 'dots'
  }).start();

  try {
    const importStart = Date.now();
    result = await importTransactions(serverUrl, password, budgetId, actualAccountId, mappedTransactions);
    importDuration = ((Date.now() - importStart) / 1000).toFixed(1);
    importSpinner.succeed(`Imported to Actual Budget (${importDuration}s)`);
  } catch (error) {
    importSpinner.fail(`Failed to import: ${error.message}`);
    throw error;
  }

  // Build summary
  const fetched = transactions.length;
  const imported = result.added?.length || 0;
  const updated = result.updated?.length || 0;
  const skipped = fetched - imported - updated;
  const errors = result.errors?.length || 0;

  // Print concise one-line summary
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✔ Synced: ${fetched} fetched, ${imported} imported, ${skipped} skipped, ${errors} errors (${totalDuration}s total)`);

  // Log errors if any
  if (errors > 0) {
    console.error("\nImport errors:");
    result.errors.forEach(err => console.error(`  - ${err}`));
  }

  // Save last sync date to .env
  updateEnvValue("LAST_SYNC_DATE", dateTo);
  console.log(`Last sync date saved: ${dateTo}`);
}
