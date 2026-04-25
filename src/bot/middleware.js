import { getUser } from "../db.js";

/**
 * Middleware that looks up the user in DB and attaches to ctx.user.
 * Does NOT block — just enriches the context for downstream handlers.
 */
export function loadUser() {
  return async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId) {
      ctx.user = await getUser(chatId);
    }
    return next();
  };
}

/**
 * Middleware that requires a registered user.
 * Replies with a prompt to /setup if not found.
 */
export function requireUser() {
  return (ctx, next) => {
    if (!ctx.user) {
      return ctx.reply("You're not set up yet. Use /setup to get started.");
    }
    return next();
  };
}

/**
 * Middleware that requires admin (ADMIN_CHAT_ID from env).
 */
export function requireAdmin() {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  return (ctx, next) => {
    if (!adminChatId || String(ctx.chat?.id) !== String(adminChatId)) {
      return ctx.reply("Admin only.");
    }
    return next();
  };
}

/**
 * Wraps an async handler to keep the "typing..." indicator alive
 * @param {Object} ctx - Telegraf context
 * @param {Function} fn - Async function to execute
 */
export async function withTyping(ctx, fn) {
  const interval = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {});
  }, 4000);

  try {
    await ctx.sendChatAction("typing");
    return await fn();
  } finally {
    clearInterval(interval);
  }
}

/**
 * Maps known errors to user-friendly messages
 * @param {Error} error
 * @returns {string}
 */
export function friendlyError(error) {
  const msg = error.message || "";
  if (msg.toLowerCase().includes("session") || msg.includes("401") || msg.includes("403")) {
    return "Enable Banking session expired. Run /connectbank to reconnect.";
  }
  if (msg.includes("ECONNREFUSED")) {
    return "Cannot connect to Actual Budget server. Is it running?";
  }
  if (msg.includes("Budget not found")) {
    return "Budget not found. Run /setup to reconfigure.";
  }
  return `Error: ${msg}`;
}
