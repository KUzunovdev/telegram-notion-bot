import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// DB schema:
//   Title          → title
//   Priority       → select:  P1 | P2 | P3
//   Status         → select:  Open | Done
//   Due            → date
//   Notes          → rich_text
//   Is Recurring   → checkbox
//   Repeat Interval→ number
//   Repeat Unit    → select:  Days | Weeks | Months

export async function createTask(task) {
  const properties = {
    Title: { title: [{ text: { content: task.title } }] },
    Priority: { select: { name: task.priority ?? "P2" } },
    Status: { select: { name: "Open" } },
  };

  if (task.due_date) {
    // due_date can be "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:00" (with time)
    // Notion requires a timezone offset when time is included
    const start = task.due_date.includes("T")
      ? task.due_date + (task.due_date.includes("+") ? "" : "+02:00")
      : task.due_date;
    properties["Due"] = { date: { start } };
  }
  if (task.remind) {
    properties["Remind"] = { checkbox: true };
  }
  if (task.notes) {
    properties["Notes"] = { rich_text: [{ text: { content: task.notes } }] };
  }
  if (task.is_recurring) {
    properties["Is Recurring"] = { checkbox: true };
    if (task.repeat_interval) {
      properties["Repeat Interval"] = { number: task.repeat_interval };
    }
    if (task.repeat_unit) {
      properties["Repeat Unit"] = { select: { name: task.repeat_unit } };
    }
  }

  return await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties,
  });
}

/** Archives every Open task in the database. */
export async function clearAllTasks() {
  let cursor;
  let count = 0;
  do {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      filter: { property: "Status", select: { does_not_equal: "Done" } },
    });
    for (const page of response.results) {
      await notion.pages.update({ page_id: page.id, archived: true });
      count++;
    }
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return count;
}

/** Finds the first open task whose title contains the given string (case-insensitive). */
export async function findTaskByRef(ref) {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Title",  rich_text: { contains: ref } },
        { property: "Status", select:    { does_not_equal: "Done" } },
      ],
    },
  });
  return response.results[0] ?? null;
}

export async function getPage(pageId) {
  return await notion.pages.retrieve({ page_id: pageId });
}

export async function completeTask(pageId) {
  return await notion.pages.update({
    page_id: pageId,
    properties: { Status: { select: { name: "Done" } } },
  });
}

export async function deleteTask(pageId) {
  return await notion.pages.update({ page_id: pageId, archived: true });
}

export async function rescheduleTask(pageId, dateISO) {
  return await notion.pages.update({
    page_id: pageId,
    properties: { Due: { date: { start: dateISO } } },
  });
}

/** Computes the next due date for a recurring task. */
export function nextRecurringDate(dueDateISO, interval, unit) {
  const d = new Date(dueDateISO);
  switch (unit) {
    case "Days":   d.setDate(d.getDate() + interval); break;
    case "Weeks":  d.setDate(d.getDate() + interval * 7); break;
    case "Months": d.setMonth(d.getMonth() + interval); break;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Fetches all Open tasks from today onwards, sorted by date then priority.
 */
export async function getUpcomingTasks() {
  const today = new Date().toISOString().slice(0, 10);
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:   { on_or_after: today } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    },
    sorts: [
      { property: "Due",      direction: "ascending" },
      { property: "Priority", direction: "ascending" },
    ],
  });
  return response.results;
}

/**
 * Fetches Open tasks with no due date set.
 */
export async function getUndatedTasks() {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:   { is_empty: true } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    },
    sorts: [{ property: "Priority", direction: "ascending" }],
  });
  return response.results;
}

/**
 * Fetches Open tasks due today with Remind = true.
 */
export async function getRemindableTasks() {
  const today = new Date().toISOString().slice(0, 10);
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:     { equals: today } },
        { property: "Status", select:   { does_not_equal: "Done" } },
        { property: "Remind", checkbox: { equals: true } },
      ],
    },
  });
  return response.results;
}

export async function getTodaysTasks() {
  const today = new Date().toISOString().slice(0, 10);
  return getTasksByDate(today);
}

export async function getTasksByDate(dateISO) {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due", date: { equals: dateISO } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    },
    sorts: [{ property: "Priority", direction: "ascending" }],
  });
  return response.results;
}

/**
 * Fetches all Open tasks with Due date before today (overdue).
 */
export async function getOverdueTasks() {
  const today = new Date().toISOString().slice(0, 10);
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:   { before: today } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    },
    sorts: [
      { property: "Priority", direction: "ascending" },
      { property: "Due",      direction: "ascending" },
    ],
  });
  return response.results;
}

/**
 * Fetches tasks marked Done with a due date of today.
 */
export async function getDoneTodayTasks() {
  const today = new Date().toISOString().slice(0, 10);
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:   { equals: today } },
        { property: "Status", select: { equals: "Done" } },
      ],
    },
    sorts: [{ property: "Priority", direction: "ascending" }],
  });
  return response.results;
}

/**
 * Fetches Done tasks with due date in the current calendar week.
 */
export async function getDoneThisWeekTasks() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const toISO = (d) => d.toISOString().slice(0, 10);

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:   { on_or_after:  toISO(monday) } },
        { property: "Due",    date:   { on_or_before: toISO(sunday) } },
        { property: "Status", select: { equals: "Done" } },
      ],
    },
    sorts: [{ property: "Due", direction: "ascending" }],
  });
  return response.results;
}

/**
 * Fetches Open tasks due next calendar week (Mon–Sun).
 */
export async function getNextWeekTasks() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilNextMonday = day === 0 ? 1 : 8 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + daysUntilNextMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const toISO = (d) => d.toISOString().slice(0, 10);

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:   { on_or_after:  toISO(monday) } },
        { property: "Due",    date:   { on_or_before: toISO(sunday) } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    },
    sorts: [
      { property: "Due",      direction: "ascending" },
      { property: "Priority", direction: "ascending" },
    ],
  });
  return response.results;
}

/**
 * Fetches all tasks due today (date or datetime) with Remind = true.
 * Broader than getRemindableTasks — catches datetime tasks too.
 */
export async function getTodayRemindableTasks() {
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:     { on_or_after: today } },
        { property: "Due",    date:     { before:      tomorrow } },
        { property: "Status", select:   { does_not_equal: "Done" } },
        { property: "Remind", checkbox: { equals: true } },
      ],
    },
  });
  return response.results;
}

/**
 * Escalates overdue task priorities:
 *   P3 → P2 after 7+ days overdue
 *   P2 → P1 after 14+ days overdue
 * Returns array of {title, oldPriority, newPriority}.
 */
export async function escalateOverdueTasks() {
  const today = new Date();
  const sevenDaysAgo    = new Date(today); sevenDaysAgo.setDate(today.getDate() - 7);
  const fourteenDaysAgo = new Date(today); fourteenDaysAgo.setDate(today.getDate() - 14);

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:   { before: today.toISOString().slice(0, 10) } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    },
  });

  const escalated = [];
  for (const page of response.results) {
    const priority = page.properties["Priority"]?.select?.name;
    const dueStr   = page.properties["Due"]?.date?.start;
    if (!dueStr || !priority) continue;

    const dueDate = new Date(dueStr);
    let newPriority = null;
    if (priority === "P3" && dueDate <= sevenDaysAgo)    newPriority = "P2";
    if (priority === "P2" && dueDate <= fourteenDaysAgo) newPriority = "P1";

    if (newPriority) {
      await notion.pages.update({
        page_id: page.id,
        properties: { Priority: { select: { name: newPriority } } },
      });
      const title = page.properties["Title"]?.title?.[0]?.plain_text ?? "(untitled)";
      escalated.push({ title, oldPriority: priority, newPriority });
    }
  }
  return escalated;
}

/**
 * Fetches all Open tasks due in the current calendar month.
 */
export async function getMonthTasks() {
  const now      = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const toISO    = (d) => d.toISOString().slice(0, 10);

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due",    date:   { on_or_after:  toISO(firstDay) } },
        { property: "Due",    date:   { on_or_before: toISO(lastDay)  } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    },
    sorts: [
      { property: "Due",      direction: "ascending" },
      { property: "Priority", direction: "ascending" },
    ],
  });
  return response.results;
}

export async function getThisWeeksTasks() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const toISO = (d) => d.toISOString().slice(0, 10);

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "Due", date: { on_or_after: toISO(monday) } },
        { property: "Due", date: { on_or_before: toISO(sunday) } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    },
    sorts: [
      { property: "Due", direction: "ascending" },
      { property: "Priority", direction: "ascending" },
    ],
  });
  return response.results;
}
