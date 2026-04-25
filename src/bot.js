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

// Graceful shutdown
const stop = () => {
  bot.stop("SIGINT");
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// Initialize DB and launch
initDb()
  .then(() => {
    startInsightScheduler(bot.telegram);
    return bot.launch();
  })
  .then(() => {
    console.log("ActualIntesa bot started (multi-user mode)");
  })
  .catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
