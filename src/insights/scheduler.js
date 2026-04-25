import cron from "node-cron";
import { listInsightUsers, updateUser } from "../db.js";
import { localParts } from "./timezone.js";
import { runDailyInsight, runWeeklyInsight, runMonthlyInsight } from "./orchestrator.js";

let tickRunning = false;

/**
 * Starts the proactive insights scheduler. Runs once per minute (server time);
 * inside each tick it walks all subscribed users and dispatches whichever
 * insight (if any) is due based on each user's local time.
 *
 * @param {Object} telegram - Telegraf bot.telegram (used to sendMessage outside any update context)
 */
export function startInsightScheduler(telegram) {
  cron.schedule("* * * * *", async () => {
    if (tickRunning) {
      console.warn("[insights] previous tick still running, skipping");
      return;
    }
    tickRunning = true;
    try {
      await tick(telegram);
    } catch (err) {
      console.error("[insights] tick error:", err);
    } finally {
      tickRunning = false;
    }
  });
  console.log("[insights] scheduler started (every-minute tick)");
}

async function tick(telegram) {
  const users = await listInsightUsers();
  for (const user of users) {
    try {
      await processUser(user, telegram);
    } catch (err) {
      console.error(`[insights] user ${user.chat_id}:`, err.message);
    }
  }
}

async function processUser(user, telegram) {
  const tz = user.timezone || "Europe/Rome";
  const parts = localParts(tz);
  const ymd = parts.ymd;

  // Monthly first — preempts the daily on day-of-month 1.
  if (
    parts.dayOfMonth === 1 &&
    parts.hour === 9 &&
    user.last_monthly_insight_date !== ymd
  ) {
    console.log(`[insights] monthly fire for ${user.chat_id} (${ymd}, ${tz})`);
    await runMonthlyInsight(user, telegram);
    await updateUser(user.chat_id, {
      last_monthly_insight_date: ymd,
      last_daily_insight_date: ymd, // suppress daily on the 1st
    });
    return;
  }

  // Weekly — Sunday 19:00 local.
  if (
    parts.weekday === "Sun" &&
    parts.hour === 19 &&
    user.last_weekly_insight_date !== ymd
  ) {
    console.log(`[insights] weekly fire for ${user.chat_id} (${ymd}, ${tz})`);
    await runWeeklyInsight(user, telegram);
    await updateUser(user.chat_id, { last_weekly_insight_date: ymd });
    return;
  }

  // Daily — 09:00 local.
  if (parts.hour === 9 && user.last_daily_insight_date !== ymd) {
    console.log(`[insights] daily fire for ${user.chat_id} (${ymd}, ${tz})`);
    const result = await runDailyInsight(user, telegram);
    await updateUser(user.chat_id, { last_daily_insight_date: ymd });
    if (result.skipped) {
      console.log(`[insights] daily skipped (no activity) for ${user.chat_id}`);
    }
  }
}
