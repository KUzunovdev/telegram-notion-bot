import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { Bot } from "grammy";
import { onVoice, onText, onCallback } from "./handlers.js";
import { getTodaysTasks } from "./notion.js";
import { formatTaskList } from "./format.js";
import { startScheduler } from "./scheduler.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set.");

const bot = new Bot(token);

// ── Auto-capture chat ID ──────────────────────────────────────────────────────

/**
 * Saves the chat ID to .env the first time we see a message from the owner.
 * On Railway the env var is set in the dashboard instead.
 */
function saveChatId(id) {
  if (process.env.TELEGRAM_CHAT_ID) return; // already set
  process.env.TELEGRAM_CHAT_ID = String(id);

  // Persist to .env file (local dev only — Railway uses dashboard env vars)
  try {
    const envPath = new URL("../../.env", import.meta.url).pathname;
    let content = readFileSync(envPath, "utf8");
    content = content.replace(
      /^TELEGRAM_CHAT_ID=.*$/m,
      `TELEGRAM_CHAT_ID=${id}`
    );
    writeFileSync(envPath, content);
    console.log(`[bot] Chat ID ${id} saved to .env`);
    // Restart scheduler now that we have the ID
    startScheduler(bot);
  } catch {
    // .env not writable (e.g. Railway) — env var in memory is enough
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

bot.command("start", (ctx) => {
  saveChatId(ctx.chat.id);
  return ctx.reply(
    "👋 Hi! I'm your personal task assistant.\n\n" +
    "*Create tasks:*\n" +
    "• Send a voice message or type any task\n" +
    "• _\"Water my plants every 2 weeks\"_ → recurring task\n\n" +
    "*Query tasks:*\n" +
    "• _what do I have today?_\n" +
    "• _show tomorrow's tasks_ · _this week's schedule_\n\n" +
    "*Manage tasks (tap buttons or type):*\n" +
    "• ✅ Complete · 🗑 Delete · ⏭ Move to tomorrow\n" +
    "• _complete 1_ · _delete 2_ · _reschedule 1_\n\n" +
    "*Reminders:*\n" +
    "• Morning digest at 9:00 AM every day\n" +
    "• Tick _Remind_ on a task in Notion → get a reminder ping",
    { parse_mode: "Markdown" }
  );
});

bot.command("chatid", (ctx) =>
  ctx.reply(`Your chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" })
);

bot.command("today", async (ctx) => {
  const pages = await getTodaysTasks();
  const { text, keyboard } = formatTaskList(pages, "Today");
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard ?? undefined });
});

bot.command("help", (ctx) =>
  ctx.reply(
    "*Commands:*\n" +
    "/start – Welcome & usage\n" +
    "/today – Today's tasks with action buttons\n" +
    "/chatid – Your chat ID\n" +
    "/help – This message\n\n" +
    "*Priorities:* P1 🔴 urgent · P2 🟡 normal · P3 🟢 someday\n" +
    "*Reminders:* tick _Remind_ in Notion on any task",
    { parse_mode: "Markdown" }
  )
);

// ── Message handlers ──────────────────────────────────────────────────────────

bot.on("message:voice",       onVoice);
bot.on("message:text", (ctx) => { saveChatId(ctx.chat.id); return onText(ctx); });
bot.on("callback_query:data", onCallback);

// ── Error boundary ────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error(`[bot] Update ${err.ctx.update.update_id}:`, err.error);
});

// ── Start ─────────────────────────────────────────────────────────────────────

console.log("🤖 Bot is starting...");
bot.start({
  onStart: (info) => {
    console.log(`✅ Bot @${info.username} is running`);
    startScheduler(bot); // starts only if TELEGRAM_CHAT_ID already set
  },
});
