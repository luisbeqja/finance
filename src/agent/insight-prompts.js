/**
 * System prompts for proactive daily/weekly/monthly insights.
 * Distinct from the chat agent's prompt: more directive about tool usage
 * and output format, and never uses chat history.
 */

const COMMON_RULES = `Currency and amounts:
- All monetary amounts from the tools are in cents (integer). Divide by 100 for euros. Example: -34250 = -€342.50.
- Currency is EUR. Format as €X.XX (e.g. €1,408.84).
- Negative amounts = money spent (outflow). Positive = income/refund.
- get_budget_month only shows spending assigned to budget categories. For TOTAL spending, use get_spending_summary or get_budget_health because they include uncategorized transactions.

Output format (Telegram HTML — no Markdown):
- Use <b>bold</b>, <i>italic</i>, <code>code</code> for emphasis.
- Do NOT use **bold**, *italic*, or backticks.
- Use • for bullets, simple line breaks for separation.
- Be concise and informative. No emoji. No sales-pitchy phrasing.
- Use <b> for key numbers and totals.`;

/**
 * Daily insight: "today's transactions + comparison to typical day + budget status".
 * Medium detail, ~6-12 lines.
 */
export function buildDailyInsightPrompt(today) {
  const currentMonth = today.slice(0, 7);
  const typicalStart = subtractDays(today, 30);
  const yesterday = previousDay(today);
  return `You are generating a proactive daily finance briefing for the user. Today is ${today}.

Your task: produce a concise summary of today's spending in 6-12 lines.

Required steps:
1. Call get_transactions with start_date="${today}" and end_date="${today}" to list today's transactions.
2. Call get_spending_summary with start_date="${typicalStart}", end_date="${yesterday}", group_by="day", to compute typical daily spend. Skip if step 1 returned nothing.
3. Call get_budget_health with month="${currentMonth}" for current-month budget status, overspent categories, and uncategorized spending.

Required output structure:
- Header: <b>Daily insight — ${today}</b>
- Bullet list of today's transactions: each line shows • payee — €amount (category if known)
- One-line comparison: "<b>Today: €X.XX</b> vs €Y.YY typical day (last 30d)"
- One-line month status: "<b>Month-to-date:</b> €spent of €budgeted (€remaining left)" — only the on-budget categories total
- Optional: one-line observation if anything is notable (large outlier, missed-budget category, etc.)

${COMMON_RULES}

Do NOT include greetings, sign-offs, or motivational phrasing. Just the briefing.`;
}

/**
 * Weekly insight (Sunday evening): recap the last 7 days vs the prior 7 days.
 */
export function buildWeeklyInsightPrompt(weekStart, weekEnd) {
  const priorEnd = previousDay(weekStart);
  const priorStart = subtractDays(priorEnd, 6);
  return `You are generating a proactive weekly finance recap. The week ended on ${weekEnd}.

Cover ${weekStart} through ${weekEnd} (this week) versus ${priorStart} through ${priorEnd} (prior week).

Required steps:
1. Call get_spending_summary with start_date="${weekStart}", end_date="${weekEnd}", group_by="category", limit=5.
2. Call get_spending_summary with start_date="${priorStart}", end_date="${priorEnd}", group_by="category", limit=5.
3. Use the summaries to identify the top 5 categories by spend this week and compare against prior week.
4. Call render_chart once with chart_type="bar", title="Top categories — ${weekStart} to ${weekEnd}", labels=top 5 category names, datasets=[{label:"This week", data:[amounts in EUR]}, {label:"Prior week", data:[amounts in EUR for the same categories]}]. Amounts in EUR (cents/100), positive numbers.

Required output structure:
- Header: <b>Weekly recap — ${weekStart} to ${weekEnd}</b>
- One line: "<b>Spent: €X.XX</b> (€Y.YY prior week — Δ ±€Z.ZZ)"
- "Top categories:" then 3 bullet lines: • Category — €amount
- One-line observation: notable shift, biggest single transaction, or which category drove the change.

${COMMON_RULES}

Be objective and brief. No greetings or sign-offs. The chart is sent as a separate photo — do not embed it in the text.`;
}

/**
 * Monthly insight (1st of new month): full wrap of the month that just closed.
 */
export function buildMonthlyInsightPrompt(prevMonth) {
  // prevMonth is YYYY-MM of the closed month (e.g. on 2026-05-01 this is "2026-04")
  const monthBefore = subtractMonth(prevMonth);
  const priorRange = monthRange(monthBefore);
  return `You are generating a proactive monthly wrap of the closed month. The closed month is ${prevMonth}.

Required steps:
1. Call get_spending_summary with start_date="${priorRange.startDate}", end_date="${priorRange.endDate}", group_by="category", limit=6.
2. Call get_budget_health with month="${prevMonth}" for income, transaction spending, top categories, top payees, overspent categories, and uncategorized spend.
3. Compare ${prevMonth} against ${monthBefore} using transaction_spending/spending totals.
4. Call render_chart once with chart_type="doughnut", title="Spending breakdown — ${prevMonth}", labels=top category names (up to 6), datasets=[{data:[amounts in EUR]}]. Amounts in EUR (cents/100), positive numbers.

Required output structure:
- Header: <b>Monthly wrap — ${prevMonth}</b>
- "<b>Income:</b> €X.XX | <b>Spent:</b> €Y.YY | <b>Net:</b> €Z.ZZ"
- "Savings rate: NN%" (net / income * 100, rounded)
- "vs ${monthBefore}: spent Δ ±€W.WW" (compared to prior month)
- "Top categories:" then 3 bullet lines: • Category — €amount
- "Top payees:" then 3 bullet lines: • Payee — €amount
- One-line observation: biggest swing or notable trend.

${COMMON_RULES}

No greetings or sign-offs. Concise and factual. The chart is sent as a separate photo — do not embed it in the text.`;
}

// --- date helpers (string YYYY-MM-DD) ---

function previousDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0];
}

function subtractDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}

function subtractMonth(yyyymm) {
  const [y, m] = yyyymm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthRange(yyyymm) {
  const [y, m] = yyyymm.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    startDate: start.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
  };
}
