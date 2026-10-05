// Zulip REST client: long-poll one event queue, send and edit stream messages.

export class Zulip {
  constructor({ site, email, apiKey, fetchImpl = fetch }) {
    if (!site || !email || !apiKey) {
      throw new Error("Zulip needs site, email, and apiKey");
    }
    this.site = site.replace(/\/$/, "");
    this.auth = `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}`;
    this.fetch = fetchImpl;
  }

  async _call(method, path, params) {
    const url = new URL(`${this.site}/api/v1/${path.replace(/^\/+/, "")}`);
    let opts = { method, headers: { Authorization: this.auth } };
    if (method === "GET") {
      for (const [k, v] of Object.entries(params || {})) {
        url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
    } else {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) {
        body.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      opts.body = body;
    }
    const res = await this.fetch(url, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.result !== "success") {
      const err = new Error(
        `Zulip ${path} ${res.status}: ${body.msg || res.statusText}`
      );
      err.status = res.status;
      throw err;
    }
    return body;
  }

  getMe() {
    return this._call("GET", "users/me");
  }

  /**
   * Subscribe the bot to a stream. A stream name that does not exist yet is
   * auto-created; the top-level invite_only makes that stream private.
   * For an existing stream the parameter is ignored (verified against the
   * API), so it is safe to always pass it.
   */
  subscribeSelf(streamName, description) {
    return this._call("POST", "users/me/subscriptions", {
      subscriptions: [{ name: streamName, description: description || "" }],
      invite_only: "true",
    });
  }

  /** Add other users to a stream. Zulip reports per-email results, not a list. */
  async subscribeOthers(streamName, emails) {
    if (!emails || emails.length === 0) return { added: [] };
    try {
      const out = await this._call("POST", "users/me/subscriptions", {
        subscriptions: [{ name: streamName }],
        principals: emails,
      });
      return {
        added: Object.keys(out.subscribed || {}),
        already: Object.keys(out.already_subscribed || {}),
        msg: out.msg || "",
      };
    } catch (err) {
      return { added: [], msg: err.message };
    }
  }

  /** One event queue. apply_markdown=false: events carry raw markdown. */
  register(narrow) {
    return this._call("POST", "register", {
      event_types: ["message"],
      apply_markdown: "false",
      narrow,
      client: "family-agent-gateway",
    });
  }

  registerStreamQueue(streamName) {
    return this.register([["stream", streamName]]);
  }

  registerPrivateQueue() {
    return this.register([["is", "private"]]);
  }

  async getEvents(queueId, lastEventId) {
    const t0 = Date.now();
    const body = await this._call("GET", "events", {
      queue_id: queueId,
      last_event_id: lastEventId,
    });
    const events = body.events || [];
    if (process.env.LOG_LEVEL === "debug") {
      console.log(
        new Date().toISOString(),
        "dbg poll",
        queueId.slice(0, 8),
        `returned in ${((Date.now() - t0) / 1000).toFixed(1)}s with ${events.length} events [${events.map((e) => e.type).join(",")}]`
      );
    }
    // Batches that contain events omit last_event_id; the last event's id
    // is the cursor. Empty batches (long-poll timeout) carry last_event_id.
    const newest =
      events.length > 0
        ? events[events.length - 1].id
        : (body.last_event_id ?? lastEventId);
    return { events, lastEventId: newest };
  }

  sendStreamMessage(stream, topic, content) {
    return this._call("POST", "messages", {
      type: "stream",
      to: JSON.stringify([stream]),
      subject: topic,
      content,
    });
  }

  sendPrivateMessage(recipientEmails, content) {
    return this._call("POST", "messages", {
      type: "private",
      to: JSON.stringify(recipientEmails),
      content,
    });
  }

  /** One message by id (fresh subject/content, e.g. after a topic rename). */
  getMessage(messageId) {
    return this._call("GET", `messages/${messageId}`);
  }

  /** Messages in one topic, oldest-last. */
  async getTopicMessages(stream, topic, numBefore = 100) {
    const body = await this._call("GET", "messages", {
      anchor: "newest",
      num_before: numBefore,
      num_after: 0,
      narrow: [
        { operator: "channel", operand: stream },
        { operator: "topic", operand: topic },
      ],
    });
    return body.messages || [];
  }

  /**
   * Move messageId and everything after it in its thread to a new topic.
   * `change_later` keeps earlier bursts in place (general chat accumulates
   * unrelated messages; change_all would mislabel them).
   */
  renameTopic(messageId, newTopic) {
    return this._call("PATCH", `messages/${messageId}`, {
      topic: newTopic,
      propagate_mode: "change_later",
      send_notification_to_old_thread: "false",
      send_notification_to_new_thread: "false",
    });
  }

  addReaction(messageId, emojiName) {
    return this._call("POST", `messages/${messageId}/reactions`, {
      emoji_name: emojiName,
    });
  }

  removeReaction(messageId, emojiName) {
    return this._call("DELETE", `messages/${messageId}/reactions`, {
      emoji_name: emojiName,
    });
  }

  /** Fetch an uploaded file (user_uploads) with the bot's credentials. */
  async downloadFile(urlPath) {
    const res = await this.fetch(new URL(urlPath, this.site), {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) {
      throw new Error(`Zulip download ${res.status}: ${urlPath.slice(0, 120)}`);
    }
    const name = decodeURIComponent(urlPath.split("/").pop()).slice(0, 80);
    return { bytes: Buffer.from(await res.arrayBuffer()), name };
  }
}
