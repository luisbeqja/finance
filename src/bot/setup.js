import { Scenes } from "telegraf";
import { getUser, saveUser, useInviteCode, saveBankAccount } from "../db.js";
import { validateConnection } from "../actual.js";
import { startAuth, createSession } from "../enablebanking.js";
import { listSupportedBanks, getBankConfig, resolveBank } from "../banks.js";

const REDIRECT_URL = "https://enablebanking.com";

function buildBankPickerMessage() {
  const banks = listSupportedBanks();
  let msg = "Which bank do you want to connect?\n\n";
  banks.forEach((b, i) => {
    msg += `${i + 1}. ${b.displayName}\n`;
  });
  msg += "\nReply with a number, or /cancel.";
  return msg;
}

function pickBankByIndex(text) {
  const banks = listSupportedBanks();
  const idx = parseInt(text, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= banks.length) return null;
  return banks[idx];
}

/**
 * Creates the setup wizard scene (Actual Budget config).
 * Bank connection is delegated to the connectbank wizard once Actual is set up.
 */
export function createSetupWizard() {
  const wizard = new Scenes.WizardScene(
    "setup-wizard",

    // Step 0: Check if returning user or ask for invite code
    async (ctx) => {
      const existing = await getUser(ctx.chat.id);
      if (existing) {
        ctx.wizard.state.data = {};
        ctx.wizard.state.isReturning = true;
        await ctx.reply(
          "Welcome back! Let's reconfigure your Actual Budget setup.\n\n" +
          "Enter your Actual Budget server URL (e.g. https://actual.example.com):"
        );
        return ctx.wizard.selectStep(2);
      }

      await ctx.reply("Welcome! To get started, please enter your invite code:");
      return ctx.wizard.next();
    },

    // Step 1: Validate invite code
    async (ctx) => {
      const code = ctx.message?.text?.trim();
      if (!code) {
        await ctx.reply("Please enter a valid invite code:");
        return;
      }

      const used = await useInviteCode(code, ctx.chat.id);
      if (!used) {
        await ctx.reply("Invalid or already used invite code. Try again:");
        return;
      }

      ctx.wizard.state.data = {};
      await ctx.reply(
        "Invite code accepted!\n\n" +
        "Now let's configure Actual Budget.\n" +
        "Enter your Actual Budget server URL (e.g. https://actual.example.com):"
      );
      return ctx.wizard.next();
    },

    // Step 2: Save server URL, ask for password
    async (ctx) => {
      const url = ctx.message?.text?.trim();
      if (!url) {
        await ctx.reply("Please enter a valid URL:");
        return;
      }

      ctx.wizard.state.data.actual_server_url = url;
      await ctx.reply("Enter your Actual Budget password:");
      return ctx.wizard.next();
    },

    // Step 3: Save password, ask for budget sync ID
    async (ctx) => {
      const password = ctx.message?.text?.trim();
      if (!password) {
        await ctx.reply("Please enter your password:");
        return;
      }

      ctx.wizard.state.data.actual_password = password;

      // Delete the password message for security
      try { await ctx.deleteMessage(ctx.message.message_id); } catch (_) {}

      await ctx.reply(
        "Password saved.\n\n" +
        "Enter your Budget Sync ID (Settings -> Advanced in Actual Budget):"
      );
      return ctx.wizard.next();
    },

    // Step 4: Save budget ID, validate Actual connection, save & ask about bank
    async (ctx) => {
      const budgetId = ctx.message?.text?.trim();
      if (!budgetId) {
        await ctx.reply("Please enter a valid Budget Sync ID:");
        return;
      }

      ctx.wizard.state.data.actual_budget_id = budgetId;

      await ctx.reply("Validating Actual Budget connection...");

      try {
        const { actual_server_url, actual_password, actual_budget_id } = ctx.wizard.state.data;
        await validateConnection(actual_server_url, actual_password, actual_budget_id);
      } catch (err) {
        await ctx.reply(
          `Connection failed: ${err.message}\n\n` +
          "Let's start over. Enter your Actual Budget server URL:"
        );
        ctx.wizard.state.data = {};
        return ctx.wizard.selectStep(2);
      }

      // Save Actual Budget config
      await saveUser(ctx.chat.id, ctx.wizard.state.data);

      await ctx.reply(
        "Actual Budget connected!\n\n" +
        "Do you want to also connect a bank account for automatic transaction sync?\n\n" +
        "Reply yes or no (you can always run /connectbank later)."
      );
      return ctx.wizard.next();
    },

    // Step 5: Ask about bank connection
    async (ctx) => {
      const answer = ctx.message?.text?.trim().toLowerCase();
      if (!answer) return;

      if (answer === "yes" || answer === "y") {
        await ctx.scene.leave();
        return ctx.scene.enter("connectbank-wizard");
      }

      await ctx.reply(
        "Setup complete! You can now use:\n" +
        "/balance - Check balances\n" +
        "/transactions - Recent transactions\n" +
        "/spending - Spending breakdown\n\n" +
        "To sync bank transactions, run /connectbank later."
      );
      return ctx.scene.leave();
    }
  );

  wizard.command("cancel", async (ctx) => {
    await ctx.reply("Setup cancelled.");
    return ctx.scene.leave();
  });

  return wizard;
}

/**
 * Creates the /connectbank wizard scene. Walks the user through:
 *   pick bank → OAuth → choose bank account → choose target Actual account.
 * The wizard supports multiple connected banks per user (one row per bank).
 */
export function createConnectBankWizard() {
  const wizard = new Scenes.WizardScene(
    "connectbank-wizard",

    // Step 0: Show bank picker
    async (ctx) => {
      const user = await getUser(ctx.chat.id);
      if (!user) {
        await ctx.reply("Run /setup first to configure Actual Budget.");
        return ctx.scene.leave();
      }
      ctx.wizard.state.user = user;
      await ctx.reply(buildBankPickerMessage());
      return ctx.wizard.next();
    },

    // Step 1: Resolve bank, start OAuth
    async (ctx) => {
      const text = ctx.message?.text?.trim();
      const bank = pickBankByIndex(text);
      if (!bank) {
        await ctx.reply("Please reply with a valid number from the list, or /cancel.");
        return;
      }

      ctx.wizard.state.bankKey = bank.key;
      ctx.wizard.state.bankDisplayName = bank.displayName;

      try {
        const appId = process.env.ENABLEBANKING_APP_ID;
        const keyPath = process.env.ENABLEBANKING_KEY_PATH;

        const aspsp = await resolveBank(appId, keyPath, bank.key);
        ctx.wizard.state.aspsp = aspsp;

        const auth = await startAuth(appId, keyPath, aspsp.name, aspsp.country, REDIRECT_URL);

        await ctx.reply(
          `Connecting to ${bank.displayName}.\n\n` +
          "Open this link to authorize:\n\n" +
          auth.url +
          "\n\nAfter completing authorization, paste the full redirect URL here."
        );
        return ctx.wizard.next();
      } catch (err) {
        await ctx.reply(`Bank connection error: ${err.message}\nTry /connectbank again.`);
        return ctx.scene.leave();
      }
    },

    // Step 2: User pastes redirect URL → create session, list bank accounts
    async (ctx) => {
      const text = ctx.message?.text?.trim();
      if (!text) {
        await ctx.reply("Please paste the redirect URL from the bank authorization:");
        return;
      }

      let code;
      try {
        const url = new URL(text);
        code = url.searchParams.get("code");
      } catch {
        code = text;
      }

      if (!code) {
        await ctx.reply("Could not extract authorization code. Please paste the full redirect URL:");
        return;
      }

      await ctx.reply("Processing bank authorization...");

      try {
        const appId = process.env.ENABLEBANKING_APP_ID;
        const keyPath = process.env.ENABLEBANKING_KEY_PATH;

        const session = await createSession(appId, keyPath, code);
        const accounts = session.accounts || [];
        if (accounts.length === 0) {
          await ctx.reply("No bank accounts found. Contact admin.");
          return ctx.scene.leave();
        }

        ctx.wizard.state.bankSessionId = session.session_id;
        ctx.wizard.state.bankAccounts = accounts;

        if (accounts.length === 1) {
          ctx.wizard.state.bankAccountId = accounts[0].uid;
          await ctx.reply(
            `Bank account detected: ${accounts[0].account_id?.iban || accounts[0].uid}\n\n` +
            "Now enter the Actual Budget Account ID where this bank's transactions should be synced.\n" +
            "(Find it in the URL when viewing the account in Actual Budget.)"
          );
          return ctx.wizard.selectStep(4);
        }

        let msg = "Select a bank account by number:\n\n";
        accounts.forEach((acc, i) => {
          const label = acc.account_id?.iban || acc.uid;
          msg += `${i + 1}. ${label}\n`;
        });
        await ctx.reply(msg);
        return ctx.wizard.next();
      } catch (err) {
        await ctx.reply(`Bank session error: ${err.message}\nTry /connectbank again.`);
        return ctx.scene.leave();
      }
    },

    // Step 3: User picks bank account (multi-account case)
    async (ctx) => {
      const text = ctx.message?.text?.trim();
      const accounts = ctx.wizard.state.bankAccounts || [];
      const idx = parseInt(text, 10) - 1;

      if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
        await ctx.reply(`Please enter a number between 1 and ${accounts.length}:`);
        return;
      }

      ctx.wizard.state.bankAccountId = accounts[idx].uid;
      const label = accounts[idx].account_id?.iban || accounts[idx].uid;
      await ctx.reply(
        `Bank account selected: ${label}\n\n` +
        "Now enter the Actual Budget Account ID where this bank's transactions should be synced.\n" +
        "(Find it in the URL when viewing the account in Actual Budget.)"
      );
      return ctx.wizard.next();
    },

    // Step 4: User enters target Actual account ID, validate, save bank account
    async (ctx) => {
      const actualAccountId = ctx.message?.text?.trim();
      if (!actualAccountId) {
        await ctx.reply("Please enter a valid Actual Account ID:");
        return;
      }

      const user = ctx.wizard.state.user;
      await ctx.reply("Validating Actual Budget account...");

      try {
        await validateConnection(
          user.actual_server_url,
          user.actual_password,
          user.actual_budget_id,
          actualAccountId
        );
      } catch (err) {
        await ctx.reply(`Validation failed: ${err.message}\n\nEnter a valid Actual Account ID:`);
        return;
      }

      const bankConfig = getBankConfig(ctx.wizard.state.bankKey);
      const aspsp = ctx.wizard.state.aspsp;

      await saveBankAccount(ctx.chat.id, bankConfig.key, {
        bank_display_name: bankConfig.displayName,
        bank_country: aspsp.country,
        enablebanking_session_id: ctx.wizard.state.bankSessionId,
        enablebanking_account_id: ctx.wizard.state.bankAccountId,
        actual_account_id: actualAccountId,
        last_sync_date: null,
      });

      await ctx.reply(
        `${bankConfig.displayName} connected!\n\n` +
        "Run /sync to import transactions, or /connectbank again to add another bank."
      );
      return ctx.scene.leave();
    }
  );

  wizard.command("cancel", async (ctx) => {
    await ctx.reply("Cancelled.");
    return ctx.scene.leave();
  });

  return wizard;
}
