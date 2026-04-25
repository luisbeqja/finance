import api from "@actual-app/api";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const dataDir = join(projectRoot, "actual-data");

/**
 * Validates connection to Actual Budget server. If `accountId` is omitted,
 * only the server/budget connection is verified.
 * @param {string} serverUrl - Actual Budget server URL
 * @param {string} password - Actual Budget password
 * @param {string} budgetId - Budget sync ID
 * @param {string|null} [accountId] - Optional account ID to verify
 * @returns {Promise<boolean>} True if connection is valid
 * @throws {Error} If connection fails with descriptive error message
 */
export async function validateConnection(serverUrl, password, budgetId, accountId = null) {
  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  try {
    // Initialize API with server connection
    await api.init({
      dataDir,
      serverURL: serverUrl,
      password: password,
    });

    // Download budget to verify budget ID is valid
    try {
      await api.downloadBudget(budgetId);
    } catch (error) {
      if (error.message?.includes("404") || error.message?.includes("not found")) {
        throw new Error(`Budget not found. Check your Budget Sync ID in Actual Budget → Settings → Advanced`);
      }
      throw new Error(`Failed to download budget: ${error.message}`);
    }

    if (!accountId) {
      return true;
    }

    // Get accounts and verify account ID exists
    const accounts = await api.getAccounts();

    if (!accounts || accounts.length === 0) {
      throw new Error("No accounts found in budget");
    }

    const accountExists = accounts.some(acc => acc.id === accountId);

    if (!accountExists) {
      const accountList = accounts.map(acc => `  - ${acc.name} (${acc.id})`).join("\n");
      throw new Error(
        `Account ID "${accountId}" not found in budget.\n\nAvailable accounts:\n${accountList}\n\nFind the account ID in the URL when viewing the account in Actual Budget.`
      );
    }

    return true;
  } catch (error) {
    // Handle specific connection errors
    if (error.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot connect to Actual Budget server at ${serverUrl}. Is the server running?`
      );
    }

    // Re-throw if already a formatted error
    if (error.message?.includes("Budget not found") ||
        error.message?.includes("Account ID") ||
        error.message?.includes("Cannot connect")) {
      throw error;
    }

    // Show the actual error for debugging
    throw new Error(`Actual Budget connection failed: ${error.message}`);
  } finally {
    // Always shut down to allow retries
    try {
      await api.shutdown();
    } catch (_) {
      // ignore shutdown errors
    }
  }
}

/**
 * Imports transactions into Actual Budget
 * @param {string} serverUrl - Actual Budget server URL
 * @param {string} password - Actual Budget password
 * @param {string} budgetId - Budget sync ID
 * @param {string} accountId - Account ID to import to
 * @param {Object[]} transactions - Array of transaction objects with date, amount, payee_name, imported_id, notes, cleared
 * @returns {Promise<Object>} Result object with added, updated, errors arrays
 */
export async function importTransactions(serverUrl, password, budgetId, accountId, transactions) {
  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  try {
    // Initialize API with server connection
    await api.init({
      dataDir,
      serverURL: serverUrl,
      password: password,
    });

    // Download budget
    await api.downloadBudget(budgetId);

    // Import transactions using Actual Budget API
    const result = await api.importTransactions(accountId, transactions);

    return result;
  } finally {
    // Always shut down
    try {
      await api.shutdown();
    } catch (_) {
      // ignore shutdown errors
    }
  }
}
