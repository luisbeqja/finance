import { runAgentLoop } from "./index.js";
import { localParts } from "../insights/timezone.js";
import {
  buildDailyInsightPrompt,
  buildWeeklyInsightPrompt,
  buildMonthlyInsightPrompt,
} from "./insight-prompts.js";

/**
 * One-shot, history-free insight generator. Uses the user's timezone to
 * derive the relevant date range for the requested kind, builds a
 * kind-specific system prompt, and runs the same Claude tool-use loop
 * the chat agent uses (same 9 tools, same model).
 *
 * @param {Object} user - User row including actual_* fields and chat_id
 * @param {"daily"|"weekly"|"monthly"} kind
 * @returns {Promise<string>} HTML message body for Telegram
 */
export async function generateInsight(user, kind) {
  const parts = localParts(user.timezone || "Europe/Rome");
  const today = parts.ymd;

  let systemPrompt;
  let userMessage;
  let maxTokens = 1024;

  if (kind === "daily") {
    systemPrompt = buildDailyInsightPrompt(today);
    userMessage = `Generate the daily insight for ${today}.`;
  } else if (kind === "weekly") {
    const weekEnd = today;
    const weekStart = subtractDays(today, 6);
    systemPrompt = buildWeeklyInsightPrompt(weekStart, weekEnd);
    userMessage = `Generate the weekly recap for ${weekStart} to ${weekEnd}.`;
  } else if (kind === "monthly") {
    const prevMonth = monthBefore(today);
    systemPrompt = buildMonthlyInsightPrompt(prevMonth);
    userMessage = `Generate the monthly wrap for ${prevMonth}.`;
    maxTokens = 1500;
  } else {
    throw new Error(`Unknown insight kind: ${kind}`);
  }

  return await runAgentLoop({
    userConfig: user,
    systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    maxTokens,
  });
}

function subtractDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}

function monthBefore(ymd) {
  const [y, m] = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
