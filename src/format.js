import { InlineKeyboard } from "grammy";

const PRIORITY_EMOJI = { P1: "🔴", P2: "🟡", P3: "🟢" };

export function prop(page, name, type) {
  const p = page.properties[name];
  if (!p) return null;
  switch (type) {
    case "title":     return p.title?.[0]?.plain_text ?? null;
    case "select":    return p.select?.name ?? null;
    case "date":      return p.date?.start ?? null;
    case "rich_text": return p.rich_text?.[0]?.plain_text ?? null;
    case "checkbox":  return p.checkbox ?? false;
    case "number":    return p.number ?? null;
    default:          return null;
  }
}

/**
 * Formats a list of Notion pages as text + inline keyboard.
 * Returns { text, keyboard }
 */
export function formatTaskList(pages, header = "Tasks") {
  if (pages.length === 0) {
    return { text: `📭 No tasks for ${header.toLowerCase()}.`, keyboard: null };
  }

  const lines = [];
  const keyboard = new InlineKeyboard();

  pages.forEach((page, i) => {
    const title    = prop(page, "Title",    "title")  ?? "(untitled)";
    const priority = prop(page, "Priority", "select");
    const dueDate  = prop(page, "Due",      "date");
    const recurring= prop(page, "Is Recurring", "checkbox");

    const emoji = PRIORITY_EMOJI[priority] ?? "⚪";
    const recurIcon = recurring ? " 🔁" : "";
    let line = `${i + 1}. ${emoji} ${title}${recurIcon}`;
    if (priority) line += ` · ${priority}`;
    if (dueDate)  line += ` · ${dueDate}`;
    lines.push(line);

    // One row of action buttons per task
    const id = page.id;
    keyboard
      .text(`✅ #${i + 1}`, `done:${id}`)
      .text(`🗑 #${i + 1}`, `del:${id}`)
      .text(`⏭ #${i + 1}`, `tmrw:${id}`)
      .row();
  });

  return {
    text: `📋 *${header}:*\n${lines.join("\n")}`,
    keyboard,
  };
}

export function formatOverdueAlert(pages) {
  if (pages.length === 0) return null;
  const lines = pages.map((page, i) => {
    const title    = prop(page, "Title",    "title")  ?? "(untitled)";
    const priority = prop(page, "Priority", "select");
    const dueDate  = prop(page, "Due",      "date");
    const emoji    = PRIORITY_EMOJI[priority] ?? "⚪";
    return `${i + 1}. ${emoji} ${title} · due ${dueDate}`;
  });
  return `⚠️ *Overdue (${pages.length}):*\n${lines.join("\n")}`;
}

export function formatEveningWrapup(doneTasks, openTasks, tomorrowTasks) {
  const parts = [];

  if (doneTasks.length > 0) {
    const lines = doneTasks.map(p => `✅ ${prop(p, "Title", "title") ?? "(untitled)"}`);
    parts.push(`*Done today (${doneTasks.length}):*\n${lines.join("\n")}`);
  } else {
    parts.push("*Done today:* nothing yet");
  }

  if (openTasks.length > 0) {
    const lines = openTasks.map(p => {
      const title = prop(p, "Title", "title") ?? "(untitled)";
      const emoji = PRIORITY_EMOJI[prop(p, "Priority", "select")] ?? "⚪";
      return `${emoji} ${title}`;
    });
    parts.push(`*Still open today (${openTasks.length}):*\n${lines.join("\n")}`);
  }

  if (tomorrowTasks.length > 0) {
    const lines = tomorrowTasks.map(p => {
      const title = prop(p, "Title", "title") ?? "(untitled)";
      const emoji = PRIORITY_EMOJI[prop(p, "Priority", "select")] ?? "⚪";
      return `${emoji} ${title}`;
    });
    parts.push(`*Tomorrow (${tomorrowTasks.length}):*\n${lines.join("\n")}`);
  }

  return `🌙 *Evening wrap-up:*\n\n${parts.join("\n\n")}`;
}

export function formatWeeklyReview(doneThisWeek, nextWeekTasks) {
  const parts = [];

  if (doneThisWeek.length > 0) {
    const lines = doneThisWeek.map(p => {
      const title   = prop(p, "Title", "title") ?? "(untitled)";
      const dueDate = prop(p, "Due",   "date");
      return `✅ ${title}${dueDate ? ` · ${dueDate}` : ""}`;
    });
    parts.push(`*This week — completed (${doneThisWeek.length}):*\n${lines.join("\n")}`);
  } else {
    parts.push("*This week:* no tasks completed");
  }

  if (nextWeekTasks.length > 0) {
    const lines = nextWeekTasks.map(p => {
      const title   = prop(p, "Title",    "title")  ?? "(untitled)";
      const dueDate = prop(p, "Due",      "date");
      const emoji   = PRIORITY_EMOJI[prop(p, "Priority", "select")] ?? "⚪";
      return `${emoji} ${title}${dueDate ? ` · ${dueDate}` : ""}`;
    });
    parts.push(`*Next week — scheduled (${nextWeekTasks.length}):*\n${lines.join("\n")}`);
  }

  return `📊 *Weekly review:*\n\n${parts.join("\n\n")}`;
}

export function formatTaskConfirmation(task) {
  const emoji = PRIORITY_EMOJI[task.priority] ?? "⚪";
  let msg = `✅ ${emoji} *${task.title}* · ${task.priority}`;
  if (task.due_date) msg += ` · ${task.due_date}`;
  if (task.is_recurring && task.repeat_interval && task.repeat_unit) {
    msg += `\n🔁 Every ${task.repeat_interval} ${task.repeat_unit.toLowerCase()}`;
  }
  if (task.notes) msg += `\n_${task.notes}_`;
  return msg;
}
