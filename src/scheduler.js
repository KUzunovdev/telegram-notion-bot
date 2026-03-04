import cron from "node-cron";
import { getTodaysTasks, getRemindableTasks } from "./notion.js";
import { formatTaskList, prop } from "./format.js";

const PRIORITY_EMOJI = { P1: "🔴", P2: "🟡", P3: "🟢" };

// IDs already reminded this calendar day — cleared at midnight
let remindedToday = new Set();

/**
 * Start all scheduled jobs.
 * @param {import("grammy").Bot} bot
 */
export function startScheduler(bot) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn("[scheduler] TELEGRAM_CHAT_ID not set — reminders disabled.");
    return;
  }

  // ── 9:00 AM — morning digest ──────────────────────────────────────────────
  cron.schedule("0 9 * * *", async () => {
    try {
      const pages = await getTodaysTasks();
      const { text, keyboard } = formatTaskList(pages, "Good morning — Today");
      await bot.api.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: keyboard ?? undefined,
      });
    } catch (err) {
      console.error("[scheduler] Morning digest failed:", err.message);
    }
  });

  // ── Every 30 min — reminder check ────────────────────────────────────────
  cron.schedule("*/30 * * * *", async () => {
    try {
      // Clear the reminded set at midnight
      const nowDate = new Date().toISOString().slice(0, 10);
      if (remindedToday.lastDate !== nowDate) {
        remindedToday = new Set();
        remindedToday.lastDate = nowDate;
      }

      const pages = await getRemindableTasks();
      for (const page of pages) {
        if (remindedToday.has(page.id)) continue;

        const title    = prop(page, "Title",    "title")  ?? "(untitled)";
        const priority = prop(page, "Priority", "select");
        const dueDate  = prop(page, "Due",       "date");
        const emoji    = PRIORITY_EMOJI[priority] ?? "⚪";

        await bot.api.sendMessage(
          chatId,
          `🔔 *Reminder:* ${emoji} ${title} · ${priority}${dueDate ? ` · ${dueDate}` : ""}`,
          { parse_mode: "Markdown" }
        );

        remindedToday.add(page.id);
      }
    } catch (err) {
      console.error("[scheduler] Reminder check failed:", err.message);
    }
  });

  console.log("✅ Scheduler started (morning digest at 09:00, reminders every 30 min)");
}
