/**
 * Tool definitions for the AI budget agent.
 * Each tool has a `definition` (sent to Claude) and an
 * `execute(api, input, ctx?)` function. `ctx` is { telegram, chatId } when
 * available — used by side-effect tools like render_chart.
 */

// Default palette for pie/doughnut/bar charts when the agent doesn't supply colors.
const CHART_PALETTE = [
  "#4e79a7", "#f28e2c", "#e15759", "#76b7b2", "#59a14f",
  "#edc949", "#af7aa1", "#ff9da7", "#9c755f", "#bab0ab",
];

const tools = [
  {
    definition: {
      name: "get_accounts",
      description:
        "List all open accounts with their current balances. Returns account name, balance (in cents), and whether it is on-budget.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    async execute(api) {
      const accounts = await api.getAccounts();
      const open = accounts.filter((a) => !a.closed);
      const results = [];
      for (const acc of open) {
        const balance = await api.getAccountBalance(acc.id);
        results.push({
          id: acc.id,
          name: acc.name,
          balance,
          onBudget: acc.offbudget === 0 || acc.offbudget === false,
        });
      }
      return results;
    },
  },

  {
    definition: {
      name: "get_transactions",
      description:
        "Query transactions with optional filters. Returns date, amount (cents), payee name, category name, and notes. Sorted by date descending.",
      input_schema: {
        type: "object",
        properties: {
          start_date: {
            type: "string",
            description: "Start date in YYYY-MM-DD format. Defaults to 90 days ago.",
          },
          end_date: {
            type: "string",
            description: "End date in YYYY-MM-DD format. Defaults to today.",
          },
          account_name: {
            type: "string",
            description: "Filter by account name (case-insensitive partial match).",
          },
          limit: {
            type: "number",
            description: "Max number of transactions to return. Defaults to 500. Use a high limit for spending summaries to capture all transactions.",
          },
          payee_name: {
            type: "string",
            description: "Filter by payee name (case-insensitive partial match). Use this to find transactions for a specific merchant.",
          },
          category_name: {
            type: "string",
            description: "Filter by category name (case-insensitive partial match). Use this to find transactions in a specific budget category.",
          },
        },
        required: [],
      },
    },
    async execute(api, input) {
      const accounts = await api.getAccounts();
      let open = accounts.filter((a) => !a.closed);

      if (input.account_name) {
        const q = input.account_name.toLowerCase();
        open = open.filter((a) => a.name.toLowerCase().includes(q));
      }

      const endDate = input.end_date || new Date().toISOString().split("T")[0];
      const startDate =
        input.start_date ||
        new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      let allTx = [];
      for (const acc of open) {
        const txs = await api.getTransactions(acc.id, startDate, endDate);
        allTx.push(...txs.map((tx) => ({ ...tx, account_name: acc.name })));
      }

      const payees = await api.getPayees();
      const categories = await api.getCategories();
      const payeeMap = new Map(payees.map((p) => [p.id, p.name]));
      const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

      if (input.payee_name) {
        const q = input.payee_name.toLowerCase();
        allTx = allTx.filter((tx) => {
          const name = payeeMap.get(tx.payee) || "";
          return name.toLowerCase().includes(q);
        });
      }

      if (input.category_name) {
        const q = input.category_name.toLowerCase();
        allTx = allTx.filter((tx) => {
          const name = categoryMap.get(tx.category) || "";
          return name.toLowerCase().includes(q);
        });
      }

      allTx.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

      const limit = input.limit || 500;
      allTx = allTx.slice(0, limit);

      return allTx.map((tx) => ({
        date: tx.date,
        amount: tx.amount,
        payee: payeeMap.get(tx.payee) || tx.payee || "(unknown)",
        category: categoryMap.get(tx.category) || "(uncategorized)",
        account: tx.account_name,
        notes: tx.notes || "",
      }));
    },
  },

  {
    definition: {
      name: "get_budget_month",
      description:
        "Get the budget breakdown for a specific month. Returns category groups with budgeted, spent, and received amounts (all in cents).",
      input_schema: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description: "Month in YYYY-MM format (e.g. 2026-02).",
          },
        },
        required: ["month"],
      },
    },
    async execute(api, input) {
      const result = await api.getBudgetMonth(input.month);
      const groups = [];
      let totalIncome = 0;
      let totalSpent = 0;

      for (const group of result.categoryGroups || []) {
        const cats = [];
        for (const cat of group.categories || []) {
          cats.push({
            name: cat.name,
            budgeted: cat.budgeted || 0,
            spent: cat.spent || 0,
            received: cat.received || 0,
            balance: cat.balance || 0,
          });
          totalIncome += cat.received || 0;
          totalSpent += cat.spent || 0;
        }
        if (cats.length > 0) {
          groups.push({ name: group.name, categories: cats });
        }
      }

      return { month: input.month, totalIncome, totalSpent, categoryGroups: groups };
    },
  },

  {
    definition: {
      name: "get_budget_summary",
      description:
        "Compare budget data across multiple months. Returns income and spending totals per month.",
      input_schema: {
        type: "object",
        properties: {
          months: {
            type: "array",
            items: { type: "string" },
            description: "Array of months in YYYY-MM format (e.g. [\"2026-01\", \"2026-02\"]).",
          },
        },
        required: ["months"],
      },
    },
    async execute(api, input) {
      const summaries = [];
      for (const month of input.months) {
        const result = await api.getBudgetMonth(month);
        let income = 0;
        let spent = 0;
        for (const group of result.categoryGroups || []) {
          for (const cat of group.categories || []) {
            income += cat.received || 0;
            spent += cat.spent || 0;
          }
        }
        summaries.push({ month, income, spent });
      }
      return summaries;
    },
  },

  {
    definition: {
      name: "get_categories",
      description:
        "List all budget categories grouped by their category group.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    async execute(api) {
      const groups = await api.getCategoryGroups();
      const categories = await api.getCategories();

      const groupMap = new Map(groups.map((g) => [g.id, { name: g.name, categories: [] }]));

      for (const cat of categories) {
        const group = groupMap.get(cat.group_id);
        if (group) {
          group.categories.push({ id: cat.id, name: cat.name });
        }
      }

      return Array.from(groupMap.values()).filter((g) => g.categories.length > 0);
    },
  },

  {
    definition: {
      name: "get_payees",
      description: "List all payees (merchants/sources of transactions).",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    async execute(api) {
      const payees = await api.getPayees();
      return payees.map((p) => ({ id: p.id, name: p.name }));
    },
  },

  {
    definition: {
      name: "get_schedules",
      description:
        "List all active recurring transactions and scheduled bills. Returns payee, account, amount, frequency, and next due date.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    async execute(api) {
      const schedules = await api.getSchedules();
      const payees = await api.getPayees();
      const accounts = await api.getAccounts();

      const payeeMap = new Map(payees.map((p) => [p.id, p.name]));
      const accountMap = new Map(accounts.map((a) => [a.id, a.name]));

      const active = schedules.filter((s) => !s.completed);

      return active.map((s) => {
        let amount;
        if (s.amount && typeof s.amount === "object" && "num1" in s.amount) {
          amount = `${s.amount.num1} to ${s.amount.num2}`;
        } else {
          amount = s.amount ?? null;
        }

        let frequency = "unknown";
        const d = s.date;
        if (d && typeof d === "object" && d.frequency) {
          const interval = d.interval || 1;
          if (interval === 1) {
            frequency = d.frequency;
          } else {
            const base = d.frequency.replace(/ly$/, "");
            frequency = `every ${interval} ${base}s`;
          }
        }

        const payeeName = payeeMap.get(s.payee) || s.payee || null;

        return {
          name: s.name || payeeName || "(unnamed)",
          payee: payeeName,
          account: accountMap.get(s.account) || null,
          amount,
          frequency,
          next_date: s.next_date || null,
          completed: !!s.completed,
        };
      });
    },
  },

  {
    definition: {
      name: "get_balance_history",
      description:
        "Get account balance at the 1st of each month going back N months. Useful for tracking savings growth and balance trends over time.",
      input_schema: {
        type: "object",
        properties: {
          account_name: {
            type: "string",
            description: "Filter by account name (case-insensitive partial match). If omitted, returns all open accounts.",
          },
          months_back: {
            type: "number",
            description: "How many months of history to return. Defaults to 6.",
          },
        },
        required: [],
      },
    },
    async execute(api, input) {
      const accounts = await api.getAccounts();
      let open = accounts.filter((a) => !a.closed);

      if (input.account_name) {
        const q = input.account_name.toLowerCase();
        open = open.filter((a) => a.name.toLowerCase().includes(q));
      }

      const monthsBack = input.months_back || 6;
      const now = new Date();
      const results = [];

      for (const acc of open) {
        for (let i = monthsBack; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const cutoff = new Date(d.getFullYear(), d.getMonth(), 1);
          const balance = await api.getAccountBalance(acc.id, cutoff);
          const yyyy = cutoff.getFullYear();
          const mm = String(cutoff.getMonth() + 1).padStart(2, "0");
          results.push({
            account: acc.name,
            date: `${yyyy}-${mm}-01`,
            balance,
          });
        }
      }

      return results;
    },
  },

  {
    definition: {
      name: "get_rules",
      description:
        "List all automation rules that auto-categorize or modify transactions. Returns human-readable conditions and actions for each rule.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    async execute(api) {
      const rules = await api.getRules();
      const payees = await api.getPayees();
      const categories = await api.getCategories();
      const accounts = await api.getAccounts();

      const payeeMap = new Map(payees.map((p) => [p.id, p.name]));
      const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
      const accountMap = new Map(accounts.map((a) => [a.id, a.name]));

      const opLabels = {
        is: "is",
        isNot: "is not",
        oneOf: "is one of",
        notOneOf: "is not one of",
        contains: "contains",
        doesNotContain: "does not contain",
        matches: "matches",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
        isapprox: "is approximately",
        isbetween: "is between",
        hasTags: "has tags",
        onBudget: "is on-budget",
        offBudget: "is off-budget",
      };

      function resolveValue(field, value) {
        if (Array.isArray(value)) {
          return value.map((v) => resolveValue(field, v)).join(", ");
        }
        if (typeof value === "object" && value !== null && "num1" in value) {
          return `${value.num1} to ${value.num2}`;
        }
        if (field === "payee" || field === "imported_payee") return payeeMap.get(value) || value;
        if (field === "category") return categoryMap.get(value) || value;
        if (field === "account") return accountMap.get(value) || value;
        return value;
      }

      const active = rules.filter((r) => !r.tombstone);

      return active.map((rule) => {
        const condParts = rule.conditions.map((c) => {
          const op = opLabels[c.op] || c.op;
          const val = resolveValue(c.field, c.value);
          return `${c.field} ${op} '${val}'`;
        });
        const joiner = rule.conditionsOp === "or" ? " OR " : " AND ";
        const conditions_description = condParts.join(joiner) || "(no conditions)";

        const actParts = rule.actions.map((a) => {
          if (a.op === "set") {
            const val = resolveValue(a.field, a.value);
            return `set ${a.field} to '${val}'`;
          }
          if (a.op === "link-schedule") return "link to schedule";
          if (a.op === "prepend-notes") return `prepend notes '${a.value}'`;
          if (a.op === "append-notes") return `append notes '${a.value}'`;
          if (a.op === "set-split-amount") return `set split amount to ${a.value}`;
          if (a.op === "delete-transaction") return "delete transaction";
          return `${a.op}: ${JSON.stringify(a.value)}`;
        });
        const actions_description = actParts.join("; ") || "(no actions)";

        return { conditions_description, actions_description };
      });
    },
  },

  {
    definition: {
      name: "render_chart",
      description:
        "Render a chart and send it to the user as a photo on Telegram. Use this when a visualization helps — category breakdowns, monthly comparisons, balance trends, top-payee bars. The chart is delivered as a separate Telegram photo with the title as caption; your text response should reference what was sent (e.g. \"Sent a bar chart of your top 5 categories\"). Do NOT call this tool more than 3 times per response.",
      input_schema: {
        type: "object",
        properties: {
          chart_type: {
            type: "string",
            enum: ["bar", "line", "pie", "doughnut", "horizontalBar"],
            description: "Chart.js type. Use bar/horizontalBar for category comparisons, line for trends over time, pie/doughnut for breakdowns of a whole.",
          },
          title: {
            type: "string",
            description: "Chart title — also used as the Telegram photo caption.",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "X-axis labels (or pie/doughnut slice labels).",
          },
          datasets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Series name. Omit for pie/doughnut." },
                data: { type: "array", items: { type: "number" }, description: "Values in EUR (NOT cents). Convert from cents before passing." },
              },
              required: ["data"],
            },
            description: "Data series. For pie/doughnut, supply exactly one dataset whose data length matches labels length.",
          },
        },
        required: ["chart_type", "title", "labels", "datasets"],
      },
    },
    async execute(api, input, ctx) {
      if (!ctx?.telegram || !ctx?.chatId) {
        return { error: "Chart rendering is not available in this context." };
      }

      const { chart_type, title, labels, datasets } = input;
      const isCircular = chart_type === "pie" || chart_type === "doughnut";

      // For pie/doughnut, color each slice from the palette unless agent supplied one.
      const enrichedDatasets = datasets.map((ds, i) => {
        const out = { ...ds };
        if (isCircular && !out.backgroundColor) {
          out.backgroundColor = labels.map((_, j) => CHART_PALETTE[j % CHART_PALETTE.length]);
        } else if (!out.backgroundColor) {
          out.backgroundColor = CHART_PALETTE[i % CHART_PALETTE.length];
        }
        return out;
      });

      const chartConfig = {
        type: chart_type,
        data: { labels, datasets: enrichedDatasets },
        options: {
          plugins: {
            title: { display: !!title, text: title, font: { size: 16 } },
            legend: { display: isCircular || datasets.length > 1 },
          },
        },
      };

      let buffer;
      try {
        const response = await fetch("https://quickchart.io/chart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chart: chartConfig,
            width: 800,
            height: 500,
            backgroundColor: "white",
            format: "png",
          }),
        });
        if (!response.ok) {
          return { error: `QuickChart failed: HTTP ${response.status}` };
        }
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        return { error: `QuickChart fetch failed: ${err.message}` };
      }

      try {
        await ctx.telegram.sendPhoto(
          ctx.chatId,
          { source: buffer },
          title ? { caption: title } : {}
        );
      } catch (err) {
        return { error: `Telegram sendPhoto failed: ${err.message}` };
      }

      return { sent: true, message: `Chart "${title}" sent as photo.` };
    },
  },
];

/** Tool definitions formatted for the Claude API */
export const toolDefinitions = tools.map((t) => ({
  name: t.definition.name,
  description: t.definition.description,
  input_schema: t.definition.input_schema,
}));

/** Map of tool name -> execute function */
export const toolExecutors = new Map(tools.map((t) => [t.definition.name, t.execute]));
