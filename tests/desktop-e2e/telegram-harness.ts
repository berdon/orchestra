import http from "node:http";
import { AddressInfo } from "node:net";

interface HarnessUpdateInput {
  chatId: string;
  title: string;
  text: string;
  chatType?: string;
  username?: string;
}

interface HarnessSentMessage {
  chat_id: string;
  text: string;
}

export interface TelegramHarness {
  apiBaseUrl: string;
  botToken: string;
  pushUpdate: (input: HarnessUpdateInput) => Promise<void>;
  listSentMessages: () => Promise<HarnessSentMessage[]>;
  close: () => Promise<void>;
}

export async function createTelegramHarness(botToken = "test-token"): Promise<TelegramHarness> {
  let nextUpdateId = 1;
  const updates: Array<Record<string, unknown>> = [];
  const sentMessages: HarnessSentMessage[] = [];

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
          message_id: nextUpdateId * 10,
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

    if (req.url === "/__test/sent-messages" && req.method === "GET") {
      respond({ ok: true, result: sentMessages });
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
      sentMessages.push({
        chat_id: String(body.chat_id ?? ""),
        text: String(body.text ?? ""),
      });
      respond({
        ok: true,
        result: {
          message_id: sentMessages.length,
          date: Math.floor(Date.now() / 1000),
          text: String(body.text ?? ""),
        },
      });
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
    async listSentMessages() {
      const response = await fetch(`http://127.0.0.1:${address.port}/__test/sent-messages`);
      if (!response.ok) {
        throw new Error(`Unable to read sent Telegram messages: ${response.status}`);
      }
      const json = await response.json() as { result?: HarnessSentMessage[] };
      return json.result ?? [];
    },
    async listChatActions() {
      const response = await fetch(`http://127.0.0.1:${address.port}/__test/chat-actions`);
      if (!response.ok) {
        throw new Error(`Unable to read Telegram chat actions: ${response.status}`);
      }
      const json = await response.json() as { result?: HarnessChatAction[] };
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
