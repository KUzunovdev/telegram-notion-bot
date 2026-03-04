import OpenAI from "openai";

// OpenRouter — all LLM calls. OpenAI (whisper.js) — audio transcription only.
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/enevora/telegram-notion-bot",
    "X-Title": "Telegram Notion Bot",
  },
});

const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

// ── Dispatcher tool ───────────────────────────────────────────────────────────
// Single function that returns an array of actions.
// One message → any number of actions in any combination.

const DISPATCH_TOOL = {
  type: "function",
  function: {
    name: "dispatch",
    description:
      "Understand the user's message and return all the actions that should be performed. A single message can request multiple actions — handle all of them.",
    parameters: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "Ordered list of actions to perform",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "create",       // save a new task
                  "query",        // show tasks for a period
                  "complete",     // mark task as done
                  "delete",       // remove one task
                  "delete_all",   // remove ALL open tasks
                  "reschedule",   // change a task's due date
                ],
                description: "The action to perform",
              },

              // ── create fields ──────────────────────────────────────────────
              title: {
                type: "string",
                description: "Task title — required for create",
              },
              priority: {
                type: "string",
                enum: ["P1", "P2", "P3"],
                description:
                  "P1 = urgent/critical, P2 = normal (default), P3 = low/someday. Always infer from context, never leave blank.",
              },
              due_date: {
                type: "string",
                description:
                  "YYYY-MM-DD for date-only, or YYYY-MM-DDTHH:MM:00 when a time is mentioned. Resolve all relative terms (tomorrow, next Monday, before 5 PM, etc.) to absolute values. For 'before X PM' use a reasonable time just before X (e.g. 'before 5 PM' → T16:30:00). Omit only for genuinely open-ended tasks.",
              },
              remind: {
                type: "boolean",
                description:
                  "true when user says 'remind me', 'don't forget', or provides a specific time",
              },
              notes: { type: "string" },
              is_recurring: { type: "boolean" },
              repeat_interval: { type: "number" },
              repeat_unit: {
                type: "string",
                enum: ["Days", "Weeks", "Months"],
              },

              // ── query fields ───────────────────────────────────────────────
              period: {
                type: "string",
                enum: ["today", "tomorrow", "this_week", "all"],
                description:
                  "Which tasks to show. Default 'all' when no specific date is mentioned.",
              },

              // ── complete / delete / reschedule fields ──────────────────────
              task_ref: {
                type: "string",
                description:
                  "Title (or partial title) of the task to act on — required for complete, delete, reschedule",
              },
              to_date: {
                type: "string",
                description:
                  "New due date YYYY-MM-DD for reschedule action",
              },
            },
            required: ["type"],
          },
        },
      },
      required: ["actions"],
    },
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Given a user message (text or transcription), returns an ordered array of
 * actions the bot should perform.
 *
 * @param {string} text
 * @param {Array<{title: string, due: string, priority: string}>} currentTasks
 *   Optional snapshot of the user's current open tasks for context.
 * @returns {Promise<Array>} actions
 */
export async function dispatch(text, currentTasks = []) {
  const now       = new Date();
  const today     = now.toISOString().slice(0, 10);
  const time      = now.toTimeString().slice(0, 5);
  const tomorrow  = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);

  const taskContext = currentTasks.length
    ? `\nOpen tasks for context:\n${currentTasks.map(t => `- [${t.priority}] "${t.title}" due ${t.due ?? "no date"}`).join("\n")}`
    : "\nNo tasks currently open.";

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: `You are a personal productivity assistant integrated with Notion.
The user speaks naturally — voice messages or casual text. Your job is to understand exactly what they want and call the dispatch function with the correct list of actions.

Context:
- Today: ${today}
- Current time: ${time} (Europe/Sofia, UTC+2)
- Tomorrow: ${tomorrow}
${taskContext}

Rules:
1. A single message can contain multiple actions — return ALL of them in order.
   Example: "delete all tasks then add call mom tomorrow and buy groceries" → [delete_all, create, create]

2. Always assign priority when creating:
   P1 = urgent / deadline / critical
   P2 = normal day-to-day (default when nothing is implied)
   P3 = low priority / someday / no rush

3. Resolve all relative dates to absolute ISO:
   "tomorrow" → ${tomorrow}
   "next Monday" → compute it
   "before 5 PM" → T16:30:00
   "at noon" → T12:00:00

4. Set remind=true whenever the user says "remind me", "don't forget", mentions a specific time, or the task has a hard deadline.

5. For queries with no specific date → use period "all" to show everything upcoming.

6. For complete/delete/reschedule, set task_ref to the task title or a clear substring of it.

7. Never ask for clarification — make reasonable inferences and act.`,
      },
      { role: "user", content: text },
    ],
    tools: [DISPATCH_TOOL],
    tool_choice: { type: "function", function: { name: "dispatch" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Model did not call dispatch");

  const { actions } = JSON.parse(toolCall.function.arguments);
  return actions;
}

/**
 * Analyzes an image (via URL) and extracts an actionable task from it.
 * Uses a vision-capable model regardless of OPENROUTER_MODEL.
 * Returns a task object {title, priority, due_date, notes} or null.
 */
export async function analyzePhoto(imageUrl) {
  const response = await client.chat.completions.create({
    model: "openai/gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a task extraction assistant. Analyze the image and extract any to-do, deadline, action item, or reminder visible in it. " +
          "Return a JSON object with: title (string, required), priority (\"P1\"|\"P2\"|\"P3\"), due_date (\"YYYY-MM-DD\" or null), notes (extra context or null). " +
          "If nothing actionable is visible, return {\"title\": null}.",
      },
      {
        role: "user",
        content: [
          { type: "text",      text: "Extract the task from this image." },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: { type: "json_object" },
  });

  try {
    const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
    return parsed.title ? parsed : null;
  } catch {
    return null;
  }
}
