const MAX_MESSAGE_LENGTH = 4000;

/**
 * Escapes HTML special characters for Telegram HTML parse mode
 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Formats an amount in cents as EUR string
 */
export function formatAmount(cents) {
  const euros = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "EUR",
  }).format(euros);
}

/**
 * Converts YYYY-MM-DD to DD/MM/YYYY
 */
export function formatDate(dateStr) {
  if (!dateStr || dateStr.length < 10) return dateStr || "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Truncates a message to fit Telegram's 4096 char limit
 */
export function truncate(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.slice(0, MAX_MESSAGE_LENGTH - 4) + "\n...";
}

/**
 * Builds the balance response message
 */
export function buildBalanceMessage(accounts) {
  if (accounts.length === 0) return "No accounts found.";

  let msg = "<b>Account Balances</b>\n\n";
  let onBudgetTotal = 0;

  for (const acc of accounts) {
    const balance = formatAmount(acc.balance);
    msg += `${escapeHtml(acc.name)}: <b>${escapeHtml(balance)}</b>\n`;
    if (acc.onBudget) onBudgetTotal += acc.balance;
  }

  msg += `\n<b>On-budget total:</b> ${escapeHtml(formatAmount(onBudgetTotal))}`;
  return truncate(msg);
}

/**
 * Builds the transactions list message
 */
export function buildTransactionsMessage(transactions, payeeMap, categoryMap) {
  if (transactions.length === 0) return "No transactions found.";

  let msg = `<b>Last ${transactions.length} Transactions</b>\n\n`;

  for (const tx of transactions) {
    const date = formatDate(tx.date);
    const amount = formatAmount(tx.amount);
    const payee = payeeMap.get(tx.payee) || "(unknown)";
    const category = categoryMap.get(tx.category) || "";
    const catStr = category ? ` [${escapeHtml(category)}]` : "";
    msg += `${escapeHtml(date)}  <b>${escapeHtml(amount)}</b>  ${escapeHtml(payee)}${catStr}\n`;
  }

  return truncate(msg);
}

/**
 * Builds the spending breakdown message
 */
export function buildSpendingMessage(month, categoryGroups, income, spent) {
  let msg = `<b>Spending for ${escapeHtml(month)}</b>\n\n`;
  msg += `Income: <b>${escapeHtml(formatAmount(income))}</b>\n`;
  msg += `Spent: <b>${escapeHtml(formatAmount(spent))}</b>\n\n`;

  for (const group of categoryGroups) {
    if (group.categories.length === 0) continue;
    msg += `<b>${escapeHtml(group.name)}</b>\n`;
    for (const cat of group.categories) {
      msg += `  ${escapeHtml(cat.name)}: ${escapeHtml(formatAmount(cat.spent))}\n`;
    }
    msg += "\n";
  }

  return truncate(msg);
}

/**
 * Builds the sync summary message. Accepts an array of per-bank results.
 */
export function buildSyncMessage({ banks, totalDuration }) {
  let msg = "<b>Sync Complete</b>\n";

  for (const b of banks) {
    msg += `\n<b>${escapeHtml(b.displayName)}</b>\n`;
    if (b.error) {
      msg += `Error: ${escapeHtml(b.error)}\n`;
      continue;
    }
    msg += `Fetched: ${b.fetched}\n`;
    msg += `Imported: ${b.imported}\n`;
    msg += `Updated: ${b.updated}\n`;
    msg += `Skipped: ${b.skipped}\n`;
    msg += `Errors: ${b.errors}\n`;
  }

  msg += `\nTotal duration: ${totalDuration}s`;
  return msg;
}

/**
 * Builds the /banks list message
 */
export function buildBanksListMessage(bankAccounts) {
  if (!bankAccounts || bankAccounts.length === 0) {
    return "No banks connected. Run /connectbank to add one.";
  }
  let msg = "<b>Connected Banks</b>\n\n";
  for (const b of bankAccounts) {
    const display = b.bank_display_name || b.bank_name;
    const lastSync = b.last_sync_date || "never";
    msg += `<b>${escapeHtml(display)}</b>\n`;
    msg += `Last sync: ${escapeHtml(lastSync)}\n\n`;
  }
  msg += "Use /disconnectbank &lt;name&gt; to remove one (e.g. /disconnectbank revolut).";
  return msg;
}

/**
 * Builds the help message
 */
export function buildHelpMessage() {
  return (
    "<b>Finance Bot</b>\n\n" +
    "/setup - Set up or reconfigure Actual Budget\n" +
    "/connectbank - Connect a bank (Intesa or Revolut)\n" +
    "/banks - List connected banks\n" +
    "/disconnectbank &lt;name&gt; - Remove a connected bank\n" +
    "/sync - Sync transactions from all connected banks\n" +
    "/balance - Account balances\n" +
    "/transactions [N] - Recent transactions (default 10)\n" +
    "/spending [YYYY-MM] - Category spending breakdown\n" +
    "/research &lt;goal&gt; - Deep multi-step AI budget analysis\n" +
    "/clear - Clear AI conversation history\n" +
    "/help - Show this message\n\n" +
    "<b>Proactive insights</b>\n" +
    "/insightstatus - Show your insight settings\n" +
    "/insightnow [daily|weekly|monthly] - Send an insight now (test)\n" +
    "/settimezone &lt;Area/City&gt; - e.g. /settimezone Europe/Rome\n" +
    "/unsubscribe - Stop the daily/weekly/monthly insights\n" +
    "/subscribe - Re-enable them\n\n" +
    "Or just type any question to ask the AI about your finances.\n" +
    "Use /research for deeper AutoResearch-style investigations with more tool steps.\n" +
    "The AI remembers the last 10 messages for follow-ups.\n\n" +
    "<b>AI Assistant</b>\n" +
    "The AI can look up your financial data using these tools:\n" +
    "- <b>Accounts</b> — balances, on/off-budget status\n" +
    "- <b>Transactions</b> — search by date, account, with payee and category info\n" +
    "- <b>Budget month</b> — category spending/income breakdown for a month\n" +
    "- <b>Budget summary</b> — compare income and spending across months\n" +
    "- <b>Spending summary</b> — transaction-based totals by category/payee/account/day\n" +
    "- <b>Budget health</b> — overspending, remaining budget, uncategorized spend\n" +
    "- <b>Categories</b> — list all budget categories and groups\n" +
    "- <b>Payees</b> — list all merchants/payees\n\n" +
    "<b>Example questions</b>\n" +
    '<i>"How much did I spend this month?"</i>\n' +
    '<i>"What were my top 5 expenses last week?"</i>\n' +
    '<i>"How much did I pay at Lidl in January?"</i>\n' +
    '<i>"Compare my spending in Jan vs Feb"</i>\n' +
    '<i>"/research find my biggest budget leaks this quarter"</i>\n' +
    '<i>"What is my account balance?"</i>\n\n' +
    "<b>Admin</b>\n" +
    "/invite - Generate an invite code\n" +
    "/users - List registered users\n" +
    "/revoke &lt;chatId&gt; - Remove a user"
  );
}
