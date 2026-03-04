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
const TZ = "Europe/Sofia";

// Task IDs reminded today — cleared at midnight
let remindedToday = new Set();
remindedToday.lastDate = "";

function resetRemindedIfNeeded() {
  const nowDate = new Date().toISOString().slice(0, 10);
  if (remindedToday.lastDate !== nowDate) {
    remindedToday = new Set();
    remindedToday.lastDate = nowDate;
  }
}

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

  // ── 9:00 AM Sofia — morning digest ───────────────────────────────────────
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
  }, { timezone: TZ });

  // ── 7:00 PM Sofia — overdue alert ─────────────────────────────────────────
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
  }, { timezone: TZ });

  // ── 9:00 PM Sofia — evening wrap-up ───────────────────────────────────────
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
  }, { timezone: TZ });

  // ── Sunday 6:00 PM Sofia — weekly review ──────────────────────────────────
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
  }, { timezone: TZ });

  // ── 3:00 AM Sofia — priority escalation ───────────────────────────────────
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
  }, { timezone: TZ });

  // ── Every 30 min — date-only reminders ────────────────────────────────────
  cron.schedule("*/30 * * * *", async () => {
    try {
      resetRemindedIfNeeded();

      const pages = await getTodayRemindableTasks();
      for (const page of pages) {
        if (remindedToday.has(page.id)) continue;

        const dueStr = prop(page, "Due", "date");
        if (dueStr && dueStr.includes("T")) continue; // datetime tasks handled by 5-min check

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

  // ── Every 5 min — time-specific reminders (fires at task time ±30 min) ────
  // Wide look-back window catches reminders missed during restarts.
  cron.schedule("*/5 * * * *", async () => {
    try {
      resetRemindedIfNeeded();

      const now        = new Date();
      const thirtyAgo  = new Date(now.getTime() - 30 * 60000);
      const fiveAhead  = new Date(now.getTime() +  5 * 60000);

      const pages = await getTodayRemindableTasks();
      for (const page of pages) {
        if (remindedToday.has(page.id)) continue;

        const dueStr = prop(page, "Due", "date");
        if (!dueStr || !dueStr.includes("T")) continue;

        const taskTime = new Date(dueStr);
        if (taskTime < thirtyAgo || taskTime > fiveAhead) continue;

        const title    = prop(page, "Title",    "title")  ?? "(untitled)";
        const priority = prop(page, "Priority", "select");
        const emoji    = PRIORITY_EMOJI[priority] ?? "⚪";

        // Display the time portion in Sofia timezone
        const localTime = taskTime.toLocaleTimeString("en-GB", {
          timeZone: TZ, hour: "2-digit", minute: "2-digit",
        });

        const sentMsg = await bot.api.sendMessage(
          chatId,
          `⏰ *Reminder:* ${emoji} ${title} · ${localTime}\n_Reply: 1h · 2h · tomorrow · skip_`,
          { parse_mode: "Markdown" }
        );

        await pushNotify({
          title:    `⏰ ${title}`,
          body:     `${localTime} · ${priority ?? "P2"}`,
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

  console.log(`✅ Scheduler started in ${TZ} (09:00 digest · 19:00 overdue · 21:00 wrap-up · Sunday 18:00 review · 03:00 escalation · time reminders every 5 min)`);
}
