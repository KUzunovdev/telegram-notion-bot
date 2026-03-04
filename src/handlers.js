import { downloadVoice, transcribe } from "./whisper.js";
import { dispatch, analyzePhoto } from "./claude.js";
import {
  createTask,
  clearAllTasks,
  findTaskByRef,
  getPage,
  completeTask,
  deleteTask,
  rescheduleTask,
  nextRecurringDate,
  getTodaysTasks,
  getThisWeeksTasks,
  getTasksByDate,
  getUpcomingTasks,
} from "./notion.js";
import { formatTaskList, formatTaskConfirmation, prop } from "./format.js";
import { reminderMessages } from "./state.js";

// Last shown task list per chat — for inline button context
const lastList = new Map();

// ── Voice entry point ─────────────────────────────────────────────────────────

export async function onVoice(ctx) {
  const statusMsg = await ctx.reply("🎙️ Transcribing...");
  try {
    const buffer        = await downloadVoice(ctx.message.voice.file_id, ctx.api.token);
    const transcription = await transcribe(buffer);

    await ctx.api.editMessageText(
      ctx.chat.id, statusMsg.message_id,
      `🎙️ _"${transcription}"_\n\n⏳ Processing...`,
      { parse_mode: "Markdown" }
    );

    await runDispatch(ctx, transcription, statusMsg.message_id);
  } catch (err) {
    console.error("[onVoice]", err.message);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ ${err.message}`);
  }
}

// ── Photo entry point ─────────────────────────────────────────────────────────

export async function onPhoto(ctx) {
  const statusMsg = await ctx.reply("🔍 Analyzing image...");
  try {
    const photo    = ctx.message.photo.at(-1); // highest resolution
    const fileInfo = await ctx.api.getFile(photo.file_id);
    const imageUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${fileInfo.file_path}`;

    const task = await analyzePhoto(imageUrl);
    if (!task) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "❓ No task found in image.");
      return;
    }

    await createTask(task);
    await ctx.api.editMessageText(
      ctx.chat.id, statusMsg.message_id,
      formatTaskConfirmation(task),
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("[onPhoto]", err.message);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ ${err.message}`);
  }
}

// ── Text entry point ──────────────────────────────────────────────────────────

export async function onText(ctx) {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  // If replying to a bot reminder, try snooze first
  if (ctx.message.reply_to_message) {
    const handled = await trySnooze(ctx, text);
    if (handled) return;
  }

  // Forwarded messages: prefix with context so the AI treats it as a task
  const isForwarded = !!(ctx.message.forward_date ?? ctx.message.forward_origin);
  const input = isForwarded ? `Create a task from this forwarded message: ${text}` : text;

  const statusMsg = await ctx.reply("⏳ Processing...");
  try {
    await runDispatch(ctx, input, statusMsg.message_id);
  } catch (err) {
    console.error("[onText]", err.message);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ ${err.message}`);
  }
}

// ── Snooze helper ─────────────────────────────────────────────────────────────
// Called when the user replies to a bot reminder message.
// Recognized commands: 1h · 2h · tomorrow / tmrw · skip

async function trySnooze(ctx, text) {
  const replyMsgId = ctx.message.reply_to_message?.message_id;
  const pageId = reminderMessages.get(replyMsgId);
  if (!pageId) return false;

  const t = text.trim().toLowerCase();
  const statusMsg = await ctx.reply("⏰ Snoozing...");

  try {
    let newDate;
    const now = new Date();

    if (t === "1h") {
      const d = new Date(now.getTime() + 3600000);
      newDate = d.toISOString().slice(0, 16) + ":00+02:00";
    } else if (t === "2h") {
      const d = new Date(now.getTime() + 7200000);
      newDate = d.toISOString().slice(0, 16) + ":00+02:00";
    } else if (t === "tomorrow" || t === "tmrw") {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      newDate = d.toISOString().slice(0, 10);
    } else if (t === "skip") {
      reminderMessages.delete(replyMsgId);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "⏭ Reminder dismissed.");
      return true;
    } else {
      // Not a snooze command — let normal dispatch handle it
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      return false;
    }

    await rescheduleTask(pageId, newDate);
    reminderMessages.delete(replyMsgId);
    await ctx.api.editMessageText(
      ctx.chat.id, statusMsg.message_id,
      `⏰ Snoozed to *${newDate.slice(0, 10)}${newDate.includes("T") ? " " + newDate.slice(11, 16) : ""}*`,
      { parse_mode: "Markdown" }
    );
    return true;
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ ${err.message}`);
    return true;
  }
}

// ── Inline button callbacks ───────────────────────────────────────────────────

export async function onCallback(ctx) {
  const data = ctx.callbackQuery?.data ?? "";
  const colonIdx = data.indexOf(":");
  const action   = data.slice(0, colonIdx);
  const pageId   = data.slice(colonIdx + 1);

  try {
    switch (action) {
      case "done": {
        const page = await getPage(pageId);
        await completeTask(pageId);

        const isRecurring = prop(page, "Is Recurring", "checkbox");
        if (isRecurring) {
          const interval = prop(page, "Repeat Interval", "number");
          const unit     = prop(page, "Repeat Unit",     "select");
          const oldDue   = prop(page, "Due",             "date");
          const title    = prop(page, "Title",           "title");
          const priority = prop(page, "Priority",        "select");
          if (interval && unit && oldDue) {
            const nextDue = nextRecurringDate(oldDue, interval, unit);
            await createTask({ title, priority, due_date: nextDue, is_recurring: true, repeat_interval: interval, repeat_unit: unit });
            await ctx.answerCallbackQuery(`✅ Done — next: ${nextDue}`);
            await refreshListMessage(ctx);
            return;
          }
        }
        await ctx.answerCallbackQuery("✅ Done");
        await refreshListMessage(ctx);
        break;
      }
      case "del": {
        await deleteTask(pageId);
        await ctx.answerCallbackQuery("🗑 Deleted");
        await refreshListMessage(ctx);
        break;
      }
      case "tmrw": {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        await rescheduleTask(pageId, d.toISOString().slice(0, 10));
        await ctx.answerCallbackQuery(`⏭ Moved to tomorrow`);
        await refreshListMessage(ctx);
        break;
      }
      default:
        await ctx.answerCallbackQuery("Unknown action");
    }
  } catch (err) {
    console.error("[onCallback]", err.message);
    await ctx.answerCallbackQuery(`❌ ${err.message}`);
  }
}

// ── Core dispatcher ───────────────────────────────────────────────────────────

async function runDispatch(ctx, text, editMsgId) {
  // Give the AI a snapshot of current tasks for context
  const currentTasks = (await getUpcomingTasks()).map(p => ({
    id:       p.id,
    title:    prop(p, "Title",    "title"),
    priority: prop(p, "Priority", "select"),
    due:      prop(p, "Due",      "date"),
  }));

  const actions = await dispatch(text, currentTasks);
  const replies  = [];

  for (const action of actions) {
    const result = await executeAction(ctx, action, currentTasks);
    if (result) replies.push(result);
  }

  const finalText = replies.join("\n\n") || "✅ Done.";

  // If there's a keyboard (from a query), send a new message with it
  const hasKeyboard = replies.some(r => typeof r === "object");
  if (hasKeyboard) {
    await ctx.api.deleteMessage(ctx.chat.id, editMsgId).catch(() => {});
    for (const r of replies) {
      if (typeof r === "string") {
        await ctx.reply(r, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(r.text, { parse_mode: "Markdown", reply_markup: r.keyboard });
      }
    }
  } else {
    await ctx.api.editMessageText(ctx.chat.id, editMsgId, finalText, {
      parse_mode: "Markdown",
    });
  }
}

async function executeAction(ctx, action, currentTasks) {
  switch (action.type) {

    case "create": {
      const task = {
        title:           action.title,
        priority:        action.priority ?? "P2",
        due_date:        action.due_date,
        remind:          action.remind,
        notes:           action.notes,
        is_recurring:    action.is_recurring,
        repeat_interval: action.repeat_interval,
        repeat_unit:     action.repeat_unit,
      };
      await createTask(task);
      return formatTaskConfirmation(task);
    }

    case "query": {
      let pages, header;
      switch (action.period) {
        case "today":
          pages  = await getTodaysTasks();
          header = "Today";
          break;
        case "tomorrow": {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          pages  = await getTasksByDate(d.toISOString().slice(0, 10));
          header = "Tomorrow";
          break;
        }
        case "this_week":
          pages  = await getThisWeeksTasks();
          header = "This week";
          break;
        default:
          pages  = await getUpcomingTasks();
          header = "Upcoming";
      }
      lastList.set(ctx.chat.id, pages.map(p => p.id));
      const { text, keyboard } = formatTaskList(pages, header);
      return keyboard ? { text, keyboard } : text;
    }

    case "delete_all": {
      const count = await clearAllTasks();
      lastList.delete(ctx.chat.id);
      return `🗑 Cleared ${count} task${count !== 1 ? "s" : ""}.`;
    }

    case "complete": {
      const page = await findTaskByRef(action.task_ref ?? "");
      if (!page) return `❓ Could not find task matching "${action.task_ref}".`;

      await completeTask(page.id);

      const isRecurring = prop(page, "Is Recurring", "checkbox");
      if (isRecurring) {
        const interval = prop(page, "Repeat Interval", "number");
        const unit     = prop(page, "Repeat Unit",     "select");
        const oldDue   = prop(page, "Due",             "date");
        const title    = prop(page, "Title",           "title");
        const priority = prop(page, "Priority",        "select");
        if (interval && unit && oldDue) {
          const nextDue = nextRecurringDate(oldDue, interval, unit);
          await createTask({ title, priority, due_date: nextDue, is_recurring: true, repeat_interval: interval, repeat_unit: unit });
          return `✅ "${title}" done — 🔁 next on ${nextDue}`;
        }
      }
      return `✅ "${prop(page, "Title", "title")}" marked as done.`;
    }

    case "delete": {
      const page = await findTaskByRef(action.task_ref ?? "");
      if (!page) return `❓ Could not find task matching "${action.task_ref}".`;
      const title = prop(page, "Title", "title");
      await deleteTask(page.id);
      return `🗑 "${title}" deleted.`;
    }

    case "reschedule": {
      const page = await findTaskByRef(action.task_ref ?? "");
      if (!page) return `❓ Could not find task matching "${action.task_ref}".`;
      const title = prop(page, "Title", "title");
      await rescheduleTask(page.id, action.to_date);
      return `⏭ "${title}" rescheduled to ${action.to_date}.`;
    }

    default:
      return null;
  }
}

async function refreshListMessage(ctx) {
  try {
    const pages = await getUpcomingTasks();
    lastList.set(ctx.chat.id, pages.map(p => p.id));
    const { text, keyboard } = formatTaskList(pages, "Upcoming");
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: keyboard ?? undefined,
    });
  } catch { /* message unchanged */ }
}
