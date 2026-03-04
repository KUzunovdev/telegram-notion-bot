import cron from "node-cron";
import {
  getTodaysTasks,
  getTodayRemindableTasks,
  getOverdueTasks,
  getDoneTodayTasks,
  getDoneThisWeekTasks,
  getNextWeekTasks,
  getTasksByDate,
  escalateOverdueTasks,
} from "./notion.js";
import {
  formatTaskList,
  formatOverdueAlert,
  formatEveningWrapup,
  formatWeeklyReview,
  prop,
} from "./format.js";
import { reminderMessages } from "./state.js";
import { pushNotify, ntfyPriority } from "./ntfy.js";

const PRIORITY_EMOJI = { P1: "🔴", P2: "🟡", P3: "🟢" };

// Task IDs reminded today (date-based reminders) — cleared at midnight
let remindedToday = new Set();
remindedToday.lastDate = "";

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

  // ── 7:00 PM — overdue alert ───────────────────────────────────────────────
  cron.schedule("0 19 * * *", async () => {
    try {
      const pages = await getOverdueTasks();
      const text  = formatOverdueAlert(pages);
      if (text) {
        await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
        await pushNotify({
          title:    `⚠️ ${pages.length} overdue task${pages.length !== 1 ? "s" : ""}`,
          body:     pages.map(p => prop(p, "Title", "title") ?? "(untitled)").join(", "),
          priority: "high",
          tags:     "warning",
        });
      }
    } catch (err) {
      console.error("[scheduler] Overdue alert failed:", err.message);
    }
  });

  // ── 9:00 PM — evening wrap-up ────────────────────────────────────────────
  cron.schedule("0 21 * * *", async () => {
    try {
      const tomorrow    = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowISO = tomorrow.toISOString().slice(0, 10);

      const [doneTasks, openTasks, tomorrowTasks] = await Promise.all([
        getDoneTodayTasks(),
        getTodaysTasks(),
        getTasksByDate(tomorrowISO),
      ]);

      const text = formatEveningWrapup(doneTasks, openTasks, tomorrowTasks);
      await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[scheduler] Evening wrap-up failed:", err.message);
    }
  });

  // ── Sunday 6:00 PM — weekly review ───────────────────────────────────────
  cron.schedule("0 18 * * 0", async () => {
    try {
      const [doneThisWeek, nextWeekTasks] = await Promise.all([
        getDoneThisWeekTasks(),
        getNextWeekTasks(),
      ]);
      const text = formatWeeklyReview(doneThisWeek, nextWeekTasks);
      await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[scheduler] Weekly review failed:", err.message);
    }
  });

  // ── 3:00 AM — priority escalation ────────────────────────────────────────
  cron.schedule("0 3 * * *", async () => {
    try {
      const escalated = await escalateOverdueTasks();
      if (escalated.length > 0) {
        const lines = escalated.map(e => `${e.oldPriority}→${e.newPriority}: ${e.title}`);
        await bot.api.sendMessage(
          chatId,
          `⬆️ *Priority escalated:*\n${lines.join("\n")}`,
          { parse_mode: "Markdown" }
        );
        const p1s = escalated.filter(e => e.newPriority === "P1");
        if (p1s.length > 0) {
          await pushNotify({
            title:    `🔴 ${p1s.length} task${p1s.length !== 1 ? "s" : ""} escalated to P1`,
            body:     p1s.map(e => e.title).join(", "),
            priority: "urgent",
            tags:     "rotating_light",
          });
        }
      }
    } catch (err) {
      console.error("[scheduler] Priority escalation failed:", err.message);
    }
  });

  // ── Every 30 min — date-only reminders ───────────────────────────────────
  // For tasks with Remind=true and a date-only due (no specific time).
  cron.schedule("*/30 * * * *", async () => {
    try {
      // Reset reminded set at midnight
      const nowDate = new Date().toISOString().slice(0, 10);
      if (remindedToday.lastDate !== nowDate) {
        remindedToday = new Set();
        remindedToday.lastDate = nowDate;
      }

      const pages = await getTodayRemindableTasks();
      for (const page of pages) {
        if (remindedToday.has(page.id)) continue;

        const dueStr = prop(page, "Due", "date");
        // Skip datetime tasks here — handled by the 10-min checker
        if (dueStr && dueStr.includes("T")) continue;

        const title    = prop(page, "Title",    "title")  ?? "(untitled)";
        const priority = prop(page, "Priority", "select");
        const emoji    = PRIORITY_EMOJI[priority] ?? "⚪";

        const sentMsg = await bot.api.sendMessage(
          chatId,
          `🔔 *Reminder:* ${emoji} ${title} · ${priority}${dueStr ? ` · ${dueStr}` : ""}`,
          { parse_mode: "Markdown" }
        );

        reminderMessages.set(sentMsg.message_id, page.id);
        remindedToday.add(page.id);
      }
    } catch (err) {
      console.error("[scheduler] Date reminder check failed:", err.message);
    }
  });

  // ── Every 10 min — time-specific reminders (ping 10 min before) ──────────
  cron.schedule("*/10 * * * *", async () => {
    try {
      const now  = new Date();
      const in10 = new Date(now.getTime() + 10 * 60000);
      const in20 = new Date(now.getTime() + 20 * 60000);

      const pages = await getTodayRemindableTasks();
      for (const page of pages) {
        if (remindedToday.has(page.id)) continue;

        const dueStr = prop(page, "Due", "date");
        if (!dueStr || !dueStr.includes("T")) continue; // date-only handled above

        const taskTime = new Date(dueStr);
        if (taskTime < in10 || taskTime >= in20) continue; // not in the 10-min window

        const title    = prop(page, "Title",    "title")  ?? "(untitled)";
        const priority = prop(page, "Priority", "select");
        const emoji    = PRIORITY_EMOJI[priority] ?? "⚪";

        const sentMsg = await bot.api.sendMessage(
          chatId,
          `⏰ *In 10 min:* ${emoji} ${title} · ${dueStr.slice(11, 16)}\n_Reply: 1h · 2h · tomorrow · skip_`,
          { parse_mode: "Markdown" }
        );

        await pushNotify({
          title:    `⏰ In 10 min: ${title}`,
          body:     `${dueStr.slice(11, 16)} · ${priority ?? "P2"}`,
          priority: ntfyPriority(priority),
          tags:     "alarm_clock",
        });

        reminderMessages.set(sentMsg.message_id, page.id);
        remindedToday.add(page.id);
      }
    } catch (err) {
      console.error("[scheduler] Time reminder check failed:", err.message);
    }
  });

  console.log("✅ Scheduler started (09:00 digest · 19:00 overdue · 21:00 wrap-up · Sunday 18:00 review · 03:00 escalation · time reminders)");
}
