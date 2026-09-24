/**
 * Max messenger bot API client.
 * Docs reference: https://api.max.ai
 *
 * Two modes are supported:
 * 1. Webhook mode (recommended): Max calls our endpoint with updates.
 * 2. Long-poll mode: we pull updates from /v1/updates.
 */

const MAX_API_BASE = "https://api.max.ai/v1";

export class MaxApiClient {
  constructor(token, fetchFn = fetch) {
    this.token = token;
    this.fetch = fetchFn;
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async get(path, query = {}) {
    const url = new URL(`${MAX_API_BASE}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const resp = await this.fetch(url.toString(), { headers: this.headers() });
    return this.json(resp);
  }

  async post(path, body = {}) {
    const resp = await this.fetch(`${MAX_API_BASE}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return this.json(resp);
  }

  async json(resp) {
    const text = await resp.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!resp.ok) {
      const err = new Error(`Max API ${resp.status}: ${text}`);
      err.status = resp.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  /**
   * Send a text message to a chat.
   * chat_id can be string or number.
   */
  async sendMessage(chatId, text, opts = {}) {
    const body = {
      chat_id: chatId,
      text,
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    };
    if (opts.replyTo) body.reply_to = opts.replyTo;
    if (opts.keyboard) body.keyboard = opts.keyboard;
    return this.post("/messages", body);
  }

  /**
   * Send a message with an inline keyboard (buttons).
   * buttons: array of rows; each row is array of { text, callback_data } or { text, url }
   */
  async sendKeyboard(chatId, text, buttons, opts = {}) {
    const keyboard = {
      type: "inline_keyboard",
      buttons: buttons.map((row) =>
        row.map((btn) => ({
          text: btn.text,
          callback_data: btn.callback_data,
          ...(btn.url ? { url: btn.url } : {}),
        }))
      ),
    };
    return this.sendMessage(chatId, text, { ...opts, keyboard });
  }

  /**
   * Edit a previously sent message (update text / keyboard).
   */
  async editMessage(messageId, text, opts = {}) {
    const body = { message_id: messageId, text };
    if (opts.keyboard) body.keyboard = opts.keyboard;
    return this.post("/messages/edit", body);
  }

  /**
   * Long-poll for updates. Returns array of update objects.
   */
  async getUpdates({ lastTimestamp, limit = 100, timeout = 25 } = {}) {
    return this.get("/updates", {
      timestamp: lastTimestamp,
      limit,
      timeout,
    });
  }

  /**
   * Get chat info.
   */
  async getChat(chatId) {
    return this.get("/chats/me", { chat_id: chatId });
  }

  /**
   * Get bot info.
   */
  async getMe() {
    return this.get("/me");
  }
}

export function buildKeyboard(buttons) {
  return {
    type: "inline_keyboard",
    buttons: buttons.map((row) =>
      row.map((btn) => ({
        text: btn.text,
        callback_data: btn.callback_data,
        ...(btn.url ? { url: btn.url } : {}),
      }))
    ),
  };
}

export function buildKeyboardFromList(items, opts = {}) {
  const columns = opts.columns || 3;
  const prefix = opts.prefix || "";
  const rows = [];
  for (let i = 0; i < items.length; i += columns) {
    const row = items.slice(i, i + columns).map((item) => {
      const text = typeof item === "object" ? item.text : String(item);
      const data = typeof item === "object" ? (item.callback_data || item.value) : String(item);
      return { text, callback_data: `${prefix}${data}` };
    });
    rows.push(row);
  }
  return rows;
}
