/**
 * Shared in-memory state across modules.
 * reminderMessages: telegram message_id → notion page_id
 * Used so the user can reply to a reminder to snooze it.
 */
export const reminderMessages = new Map();
