import { syncBankAccount } from "../sync.js";
import { generateInsight } from "../agent/insights.js";
import { truncate } from "../bot/format.js";

/**
 * Sync all of the user's banks first, then generate and send the daily insight.
 * If no transactions were imported across all banks (and force=false), skip silently.
 */
export async function runDailyInsight(user, telegram, { force = false } = {}) {
  let importedTotal = 0;
  for (const bank of user.bankAccounts || []) {
    try {
      const r = await syncBankAccount(user, bank);
      importedTotal += r.imported || 0;
    } catch (err) {
      console.error(`[insights] sync failed for ${user.chat_id}/${bank.bank_name}:`, err.message);
    }
  }

  if (importedTotal === 0 && !force) {
    return { skipped: "no-activity", importedTotal };
  }

  const text = await generateInsight(user, "daily");
  await telegram.sendMessage(user.chat_id, truncate(text), { parse_mode: "HTML" });
  return { sent: true, importedTotal };
}

/**
 * Generate and send the weekly insight. No sync — assumes the daily flow
 * has been keeping data fresh through the week.
 */
export async function runWeeklyInsight(user, telegram) {
  const text = await generateInsight(user, "weekly");
  await telegram.sendMessage(user.chat_id, truncate(text), { parse_mode: "HTML" });
  return { sent: true };
}

/**
 * Generate and send the monthly insight.
 */
export async function runMonthlyInsight(user, telegram) {
  const text = await generateInsight(user, "monthly");
  await telegram.sendMessage(user.chat_id, truncate(text), { parse_mode: "HTML" });
  return { sent: true };
}

/**
 * Public dispatcher used by the /insightnow command and the scheduler.
 * @param {Object} user
 * @param {"daily"|"weekly"|"monthly"} kind
 * @param {Object} telegram - bot.telegram (Telegraf)
 * @param {Object} [opts]
 * @param {boolean} [opts.force=false] - bypass no-activity skip on daily
 */
export async function runInsight(user, kind, telegram, opts = {}) {
  if (kind === "daily") return await runDailyInsight(user, telegram, opts);
  if (kind === "weekly") return await runWeeklyInsight(user, telegram);
  if (kind === "monthly") return await runMonthlyInsight(user, telegram);
  throw new Error(`Unknown insight kind: ${kind}`);
}
