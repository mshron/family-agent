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

  subscribeSelf(streamName, description) {
    return this._call("POST", "users/me/subscriptions", {
      subscriptions: [{ name: streamName, description: description || "" }],
    });
  }

  async subscribeOthers(streamName, emails) {
    if (!emails || emails.length === 0) return { added: [] };
    try {
      const out = await this._call("POST", "users/me/subscriptions", {
        subscriptions: [{ name: streamName }],
        principals: emails,
      });
      return { added: out.added || [] };
    } catch (err) {
      return { added: [], msg: err.message };
    }
  }

  register(streamName) {
    return this._call("POST", "register", {
      event_types: ["message"],
      narrow: [["stream", streamName]],
      client: "family-agent-gateway",
    });
  }

  async getEvents(queueId, lastEventId) {
    const body = await this._call("GET", "events", {
      queue_id: queueId,
      last_event_id: lastEventId,
    });
    const events = body.events || [];
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
}
