import "dotenv/config";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Telegraf, Scenes, session } from "telegraf";
import { initDb } from "./db.js";
import { loadUser } from "./bot/middleware.js";
import { registerCommands } from "./bot/commands.js";
import { createSetupWizard, createConnectBankWizard } from "./bot/setup.js";
import { startInsightScheduler } from "./insights/scheduler.js";

// If ENABLEBANKING_KEY_CONTENT is set (e.g. on Railway), write it to a temp file
// and point ENABLEBANKING_KEY_PATH to it
if (process.env.ENABLEBANKING_KEY_CONTENT && !process.env.ENABLEBANKING_KEY_PATH) {
  const keyPath = join(tmpdir(), "enablebanking-key.pem");
  writeFileSync(keyPath, process.env.ENABLEBANKING_KEY_CONTENT, "utf-8");
  process.env.ENABLEBANKING_KEY_PATH = keyPath;
}

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new Telegraf(token);

// Set up scenes (setup + bank connection wizards)
const setupWizard = createSetupWizard();
const connectBankWizard = createConnectBankWizard();
const stage = new Scenes.Stage([setupWizard, connectBankWizard]);

// Session middleware (required for scenes)
bot.use(session());

// Stage middleware (processes scene transitions)
bot.use(stage.middleware());

// Load user from DB on every request
bot.use(loadUser());

// /setup enters the wizard scene
bot.command("setup", (ctx) => ctx.scene.enter("setup-wizard"));
bot.command("connectbank", (ctx) => ctx.scene.enter("connectbank-wizard"));

// Register all commands
registerCommands(bot);

// Visible command list shown in Telegram's "/" autocomplete menu.
// Admin commands (/invite, /users, /revoke) are intentionally omitted —
// admins can still type them manually.
const COMMAND_MENU = [
  { command: "help", description: "Show help and command list" },
  { command: "setup", description: "Set up Actual Budget" },
  { command: "connectbank", description: "Connect a bank (Intesa or Revolut)" },
  { command: "banks", description: "List connected banks" },
  { command: "disconnectbank", description: "Disconnect a bank" },
  { command: "sync", description: "Sync transactions from all banks" },
  { command: "balance", description: "Show account balances" },
  { command: "transactions", description: "Recent transactions" },
  { command: "spending", description: "Spending breakdown" },
  { command: "research", description: "Deep multi-step budget analysis" },
  { command: "insightstatus", description: "Show insight settings" },
  { command: "insightnow", description: "Send an insight now" },
  { command: "settimezone", description: "Set your timezone" },
  { command: "subscribe", description: "Re-enable scheduled insights" },
  { command: "unsubscribe", description: "Stop scheduled insights" },
  { command: "clear", description: "Clear AI conversation history" },
];

// Graceful shutdown
const stop = () => {
  bot.stop("SIGINT");
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// Initialize DB and launch
initDb()
  .then(async () => {
    await bot.telegram.setMyCommands(COMMAND_MENU);
    startInsightScheduler(bot.telegram);
    bot.launch();
    console.log("ActualIntesa bot started (multi-user mode)");
  })
  .catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
