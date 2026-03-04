/**
 * Sends a native push notification via ntfy.sh to your iPhone.
 * Set NTFY_TOPIC in .env to enable (e.g. "kiril-tasks-xyz123").
 *
 * ntfy priority levels: min · low · default · high · urgent
 */
export async function pushNotify({ title, body, priority = "default", tags = "bell" }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        "Title":    title,
        "Priority": priority,
        "Tags":     tags,
      },
      body,
    });
  } catch (err) {
    console.error("[ntfy] Push failed:", err.message);
  }
}

/** Maps Notion priority to ntfy priority */
export function ntfyPriority(notionPriority) {
  switch (notionPriority) {
    case "P1": return "urgent";
    case "P2": return "high";
    default:   return "default";
  }
}
