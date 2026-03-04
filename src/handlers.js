import { downloadVoice, transcribe } from "./whisper.js";
import { dispatch } from "./claude.js";
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

// ── Text entry point ──────────────────────────────────────────────────────────

export async function onText(ctx) {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  const statusMsg = await ctx.reply("⏳ Processing...");
  try {
    await runDispatch(ctx, text, statusMsg.message_id);
  } catch (err) {
    console.error("[onText]", err.message);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ ${err.message}`);
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
