import http from "node:http";
import { AddressInfo } from "node:net";

interface HarnessUpdateInput {
  chatId: string;
  title: string;
  text: string;
  chatType?: string;
  username?: string;
}

interface HarnessCallbackInput {
  chatId: string;
  title: string;
  data: string;
  messageId?: number;
  chatType?: string;
  username?: string;
}

export interface HarnessSentMessage {
  message_id: number;
  chat_id: string;
  text: string;
  reply_markup?: unknown;
}

export interface HarnessChatAction {
  chat_id: string;
  action: string;
}

export interface HarnessCallbackAnswer {
  callback_query_id: string;
  text: string;
}

export interface TelegramHarness {
  apiBaseUrl: string;
  botToken: string;
  pushUpdate: (input: HarnessUpdateInput) => Promise<void>;
  pushCallback: (input: HarnessCallbackInput) => Promise<void>;
  listSentMessages: () => Promise<HarnessSentMessage[]>;
  listChatActions: () => Promise<HarnessChatAction[]>;
  listCallbackAnswers: () => Promise<HarnessCallbackAnswer[]>;
  close: () => Promise<void>;
}

export async function createTelegramHarness(botToken = "test-token"): Promise<TelegramHarness> {
  let nextUpdateId = 1;
  let nextMessageId = 1;
  const updates: Array<Record<string, unknown>> = [];
  const sentMessages: HarnessSentMessage[] = [];
  const chatActions: HarnessChatAction[] = [];
  const callbackAnswers: HarnessCallbackAnswer[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};

    const respond = (value: unknown, statusCode = 200) => {
      res.statusCode = statusCode;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };

    if (req.url === "/__test/push-update" && req.method === "POST") {
      const input = body as HarnessUpdateInput;
      updates.push({
        update_id: nextUpdateId++,
        message: {
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          text: input.text,
          chat: {
            id: input.chatId,
            type: input.chatType ?? "private",
            title: input.title,
            first_name: input.title,
            username: input.username ?? "operator",
          },
        },
      });
      respond({ ok: true });
      return;
    }

    if (req.url === "/__test/push-callback" && req.method === "POST") {
      const input = body as HarnessCallbackInput;
      updates.push({
        update_id: nextUpdateId++,
        callback_query: {
          id: `callback-${nextUpdateId}`,
          data: input.data,
          from: {
            id: 1,
            is_bot: false,
            first_name: input.title,
            username: input.username ?? "operator",
          },
          message: {
            message_id: input.messageId ?? 1,
            date: Math.floor(Date.now() / 1000),
            chat: {
              id: input.chatId,
              type: input.chatType ?? "private",
              title: input.title,
              first_name: input.title,
              username: input.username ?? "operator",
            },
          },
        },
      });
      respond({ ok: true });
      return;
    }

    if (req.url === "/__test/sent-messages" && req.method === "GET") {
      respond({ ok: true, result: sentMessages });
      return;
    }

    if (req.url === "/__test/chat-actions" && req.method === "GET") {
      respond({ ok: true, result: chatActions });
      return;
    }

    if (req.url === "/__test/callback-answers" && req.method === "GET") {
      respond({ ok: true, result: callbackAnswers });
      return;
    }

    const path = req.url ?? "";
    const methodMatch = path.match(new RegExp(`^/bot${botToken}/([^/?]+)$`));
    if (!methodMatch) {
      respond({ ok: false, description: `Unknown path ${path}` }, 404);
      return;
    }

    const telegramMethod = methodMatch[1]!;
    if (telegramMethod === "getMe") {
      respond({
        ok: true,
        result: {
          id: 1,
          is_bot: true,
          first_name: "Orchestra Test Bot",
          username: "orchestra_test_bot",
        },
      });
      return;
    }

    if (telegramMethod === "getUpdates") {
      const offset = typeof body.offset === "number" ? body.offset : Number(body.offset ?? 0);
      const result = updates.filter((update) => Number(update.update_id ?? 0) >= offset);
      respond({ ok: true, result });
      return;
    }

    if (telegramMethod === "sendMessage") {
      const message: HarnessSentMessage = {
        message_id: nextMessageId++,
        chat_id: String(body.chat_id ?? ""),
        text: String(body.text ?? ""),
        reply_markup: body.reply_markup,
      };
      sentMessages.push(message);
      respond({
        ok: true,
        result: {
          message_id: message.message_id,
          date: Math.floor(Date.now() / 1000),
          text: message.text,
          reply_markup: message.reply_markup,
        },
      });
      return;
    }

    if (telegramMethod === "sendChatAction") {
      chatActions.push({
        chat_id: String(body.chat_id ?? ""),
        action: String(body.action ?? ""),
      });
      respond({ ok: true, result: true });
      return;
    }

    if (telegramMethod === "answerCallbackQuery") {
      callbackAnswers.push({
        callback_query_id: String(body.callback_query_id ?? ""),
        text: String(body.text ?? ""),
      });
      respond({ ok: true, result: true });
      return;
    }

    respond({ ok: false, description: `Unsupported Telegram method ${telegramMethod}` }, 400);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    botToken,
    async pushUpdate(input: HarnessUpdateInput) {
      const response = await fetch(`http://127.0.0.1:${address.port}/__test/push-update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(`Unable to push Telegram update: ${response.status}`);
      }
    },
    async pushCallback(input: HarnessCallbackInput) {
      const response = await fetch(`http://127.0.0.1:${address.port}/__test/push-callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(`Unable to push Telegram callback: ${response.status}`);
      }
    },
    async listSentMessages() {
      const response = await fetch(`http://127.0.0.1:${address.port}/__test/sent-messages`);
      if (!response.ok) {
        throw new Error(`Unable to read sent Telegram messages: ${response.status}`);
      }
      const json = (await response.json()) as { result?: HarnessSentMessage[] };
      return json.result ?? [];
    },
    async listChatActions() {
      const response = await fetch(`http://127.0.0.1:${address.port}/__test/chat-actions`);
      if (!response.ok) {
        throw new Error(`Unable to read Telegram chat actions: ${response.status}`);
      }
      const json = (await response.json()) as { result?: HarnessChatAction[] };
      return json.result ?? [];
    },
    async listCallbackAnswers() {
      const response = await fetch(`http://127.0.0.1:${address.port}/__test/callback-answers`);
      if (!response.ok) {
        throw new Error(`Unable to read Telegram callback answers: ${response.status}`);
      }
      const json = (await response.json()) as { result?: HarnessCallbackAnswer[] };
      return json.result ?? [];
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
