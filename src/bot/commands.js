import { syncBankAccount } from "../sync.js";
import { withActual } from "./actual-query.js";
import { requireUser, requireAdmin, withTyping, friendlyError } from "./middleware.js";
import {
  deleteBankAccount,
  createInviteCode,
  listUsers,
  deleteUser,
  updateUser,
} from "../db.js";
import {
  buildBalanceMessage,
  buildTransactionsMessage,
  buildSpendingMessage,
  buildSyncMessage,
  buildBanksListMessage,
  buildHelpMessage,
} from "./format.js";
import { askAgent, clearHistory } from "../agent/index.js";
import { isValidTimezone } from "../insights/timezone.js";
import { runInsight } from "../insights/orchestrator.js";

export function registerCommands(bot) {
  bot.command("start", (ctx) => ctx.replyWithHTML(buildHelpMessage()));
  bot.command("help", (ctx) => ctx.replyWithHTML(buildHelpMessage()));

  // --- User commands (require registered user) ---

  bot.command("sync", requireUser(), async (ctx) => {
    const banks = ctx.user.bankAccounts || [];
    if (banks.length === 0) {
      return ctx.reply("No banks connected. Run /connectbank first.");
    }

    try {
      await withTyping(ctx, async () => {
        const startTime = Date.now();
        const results = [];

        for (const bank of banks) {
          const displayName = bank.bank_display_name || bank.bank_name;
          try {
            const r = await syncBankAccount(ctx.user, bank);
            results.push({ displayName, ...r });
          } catch (err) {
            results.push({ displayName, error: err.message });
          }
        }

        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
        await ctx.replyWithHTML(buildSyncMessage({ banks: results, totalDuration }));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("banks", requireUser(), async (ctx) => {
    await ctx.replyWithHTML(buildBanksListMessage(ctx.user.bankAccounts));
  });

  bot.command("disconnectbank", requireUser(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const target = args[0]?.toLowerCase();
    if (!target) {
      return ctx.reply("Usage: /disconnectbank <name> (e.g. /disconnectbank revolut)");
    }
    const removed = await deleteBankAccount(ctx.chat.id, target);
    if (!removed) {
      return ctx.reply(`No connected bank named "${target}". Use /banks to see what's connected.`);
    }
    await ctx.reply(`Disconnected ${target}.`);
  });

  bot.command("balance", requireUser(), async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const user = ctx.user;
        const accounts = await withActual(user, async (api) => {
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

        await ctx.replyWithHTML(buildBalanceMessage(accounts));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("transactions", requireUser(), async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const user = ctx.user;
        const args = ctx.message.text.split(/\s+/).slice(1);
        let count = parseInt(args[0], 10);
        if (!count || count < 1) count = 10;
        if (count > 25) count = 25;

        const data = await withActual(user, async (api) => {
          const accounts = await api.getAccounts();
          const open = accounts.filter((a) => !a.closed);

          const endDate = new Date().toISOString().split("T")[0];
          const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

          let allTx = [];
          for (const acc of open) {
            const txs = await api.getTransactions(acc.id, startDate, endDate);
            allTx.push(...txs);
          }

          const payees = await api.getPayees();
          const categories = await api.getCategories();

          return { transactions: allTx, payees, categories };
        });

        const payeeMap = new Map(data.payees.map((p) => [p.id, p.name]));
        const categoryMap = new Map(data.categories.map((c) => [c.id, c.name]));

        const sorted = data.transactions
          .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
          .slice(0, count);

        await ctx.replyWithHTML(buildTransactionsMessage(sorted, payeeMap, categoryMap));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("spending", requireUser(), async (ctx) => {
    try {
      await withTyping(ctx, async () => {
        const user = ctx.user;
        const args = ctx.message.text.split(/\s+/).slice(1);
        let month = args[0];
        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
          const now = new Date();
          month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        }

        const result = await withActual(user, async (api) => {
          return await api.getBudgetMonth(month);
        });

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

        await ctx.replyWithHTML(buildSpendingMessage(month, groups, income, spent));
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("clear", requireUser(), (ctx) => {
    clearHistory(ctx.chat.id);
    return ctx.reply("Chat context cleared.");
  });

  // --- Proactive insights ---

  bot.command("subscribe", requireUser(), async (ctx) => {
    await updateUser(ctx.chat.id, { insights_enabled: true });
    await ctx.reply("Insights enabled. You'll get a daily summary at 09:00 your local time.");
  });

  bot.command("unsubscribe", requireUser(), async (ctx) => {
    await updateUser(ctx.chat.id, { insights_enabled: false });
    await ctx.reply("Insights disabled. Re-enable with /subscribe.");
  });

  bot.command("settimezone", requireUser(), async (ctx) => {
    const tz = ctx.message.text.split(/\s+/)[1];
    if (!tz || !isValidTimezone(tz)) {
      return ctx.reply("Usage: /settimezone <Area/City> (e.g. /settimezone Europe/Rome)");
    }
    await updateUser(ctx.chat.id, { timezone: tz });
    await ctx.reply(`Timezone set to ${tz}.`);
  });

  bot.command("insightnow", requireUser(), async (ctx) => {
    const kind = (ctx.message.text.split(/\s+/)[1] || "daily").toLowerCase();
    if (!["daily", "weekly", "monthly"].includes(kind)) {
      return ctx.reply("Usage: /insightnow [daily|weekly|monthly]");
    }
    try {
      await withTyping(ctx, async () => {
        const result = await runInsight(ctx.user, kind, ctx.telegram, { force: true });
        if (result.skipped) {
          await ctx.reply("(no activity today — skipped)");
        }
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });

  bot.command("insightstatus", requireUser(), async (ctx) => {
    const u = ctx.user;
    await ctx.replyWithHTML(
      `Insights: <b>${u.insights_enabled ? "on" : "off"}</b>\n` +
        `Timezone: <code>${u.timezone || "Europe/Rome"}</code>\n` +
        `Last daily: ${u.last_daily_insight_date || "never"}\n` +
        `Last weekly: ${u.last_weekly_insight_date || "never"}\n` +
        `Last monthly: ${u.last_monthly_insight_date || "never"}`
    );
  });

  // --- Admin commands ---

  bot.command("invite", requireAdmin(), async (ctx) => {
    const code = await createInviteCode();
    await ctx.reply(`Invite code: ${code}`);
  });

  bot.command("users", requireAdmin(), async (ctx) => {
    const users = await listUsers();
    if (users.length === 0) {
      return ctx.reply("No registered users.");
    }
    let msg = `Registered users (${users.length}):\n\n`;
    for (const u of users) {
      msg += `Chat ID: ${u.chat_id} | Joined: ${u.created_at || "?"} | Banks: ${u.bank_count} | Last sync: ${u.last_sync_date || "never"}\n`;
    }
    await ctx.reply(msg);
  });

  bot.command("revoke", requireAdmin(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const targetChatId = args[0];
    if (!targetChatId) {
      return ctx.reply("Usage: /revoke <chatId>");
    }
    const deleted = await deleteUser(targetChatId);
    if (deleted) {
      await ctx.reply(`User ${targetChatId} has been removed.`);
    } else {
      await ctx.reply(`No user found with chat ID ${targetChatId}.`);
    }
  });

  // --- Default: any plain text message goes to the AI agent ---

  bot.on("text", async (ctx) => {
    // Skip commands (already handled above)
    if (ctx.message.text.startsWith("/")) return;
    if (!ctx.user) {
      return ctx.reply("You're not set up yet. Use /setup to get started.");
    }
    const question = ctx.message.text.trim();
    if (!question) return;
    try {
      await withTyping(ctx, async () => {
        const answer = await askAgent(ctx.user, question);
        await ctx.replyWithHTML(answer);
      });
    } catch (error) {
      await ctx.replyWithHTML(friendlyError(error));
    }
  });
}
