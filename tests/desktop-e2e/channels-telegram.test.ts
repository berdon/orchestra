import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  selectValue,
  setInputValue,
  waitForSelectOption,
  waitForSelector,
  waitForText,
} from "./driver";
import { createTelegramHarness } from "./telegram-harness";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function waitForSentMessage(
  harness: Awaited<ReturnType<typeof createTelegramHarness>>,
  matcher: (text: string) => boolean,
  timeoutMs = 90_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastMessages: Array<{ chat_id: string; text: string }> = [];
  while (Date.now() < deadline) {
    lastMessages = await harness.listSentMessages();
    const match = [...lastMessages].reverse().find((message) => matcher(message.text));
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for sent message. Last messages: ${JSON.stringify(lastMessages)}`);
}

describe("desktop channels telegram flow", () => {
  it.skipIf(!isDesktopE2E)("configures a Telegram channel, delivers supervisor replies, supports commands, and keeps a single supervisor session across project changes", async () => {
    const harness = await createTelegramHarness();
    const sessionId = await createReadyWebdriverSession();
    const suffix = Date.now().toString(36);
    const secondProjectName = `ChannelSecondary${suffix}`;
    const firstReplyToken = `CHANNEL_REPLY_${suffix}`;
    const secondReplyToken = `PROJECT_SWITCH_REPLY_${suffix}`;

    try {
      await ensureReactReady(sessionId);
      await invokeCommand(sessionId, "create_project", { input: { name: secondProjectName, description: "Second project for channel routing" } });
      const models = await invokeCommand<Array<{ id: string; provider: string }>>(sessionId, "list_pi_models");
      const model = models[0];
      expect(model).toBeTruthy();

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, '[role="tab"]', "Channels");
      await clickSelector(sessionId, '[data-role="new-channel"]');
      await setInputValue(sessionId, '[data-role="channel-name"]', `Telegram Ops ${suffix}`);
      await selectValue(sessionId, '[data-role="channel-default-project"]', 'orchestra');
      await setInputValue(sessionId, '[data-role="telegram-bot-token"]', harness.botToken);
      await setInputValue(sessionId, '[data-role="telegram-api-base-url"]', harness.apiBaseUrl);
      await clickSelector(sessionId, '[data-role="validate-telegram-bot"]');
      await waitForText(sessionId, '@orchestra_test_bot');

      await harness.pushUpdate({
        chatId: `chat-${suffix}`,
        title: `Operator ${suffix}`,
        text: "/start",
      });
      await clickSelector(sessionId, '[data-role="detect-telegram-chats"]');
      await waitForSelectOption(sessionId, '[data-role="telegram-chat-select"]', { value: `chat-${suffix}` });
      await selectValue(sessionId, '[data-role="telegram-chat-select"]', `chat-${suffix}`);
      await clickSelector(sessionId, '[data-role="channel-enabled"]');
      await clickSelector(sessionId, '[data-role="save-channel"]');
      await waitForText(sessionId, `Telegram Ops ${suffix}`);
      const channels = await invokeCommand<Array<{ name: string; enabled: boolean; status: string; defaultProjectId?: string | null }>>(sessionId, "list_channels");
      if (!channels.some((channel) => channel.name === `Telegram Ops ${suffix}` && channel.enabled && channel.status === "ready")) {
        throw new Error(`Channel did not become ready: ${JSON.stringify(channels)}`);
      }
      await waitForSentMessage(harness, (text) => text.includes("Plain text messages are delivered to the supervisor"));

      await harness.pushUpdate({
        chatId: `chat-${suffix}`,
        title: `Operator ${suffix}`,
        text: `/model ${model.provider}/${model.id}`,
      });
      await waitForSentMessage(harness, (text) => text.includes(`Model changed to ${model.provider}/${model.id}.`));

      await harness.pushUpdate({
        chatId: `chat-${suffix}`,
        title: `Operator ${suffix}`,
        text: `Reply with exactly ${firstReplyToken}.`,
      });
      await waitForSentMessage(harness, (text) => text.includes("Queued for supervisor.") || text.includes("Sent to supervisor session.") || text.includes(firstReplyToken) || text.startsWith("Supervisor run failed:"));

      await harness.pushUpdate({
        chatId: `chat-${suffix}`,
        title: `Operator ${suffix}`,
        text: "/status",
      });
      await waitForSentMessage(harness, (text) => text.includes("Default project: Orchestra"));

      await harness.pushUpdate({
        chatId: `chat-${suffix}`,
        title: `Operator ${suffix}`,
        text: `/project ${secondProjectName}`,
      });
      await waitForSentMessage(harness, (text) => text.includes(`Default project set to ${secondProjectName}.`));

      await harness.pushUpdate({
        chatId: `chat-${suffix}`,
        title: `Operator ${suffix}`,
        text: `Reply with exactly ${secondReplyToken}.`,
      });
      await waitForChatAction(harness, (entry) => entry.chat_id === `chat-${suffix}` && entry.action === 'typing');
      await waitForSentMessage(harness, (text) => text.includes(secondReplyToken) || text.startsWith("Supervisor run failed:"));

      await harness.pushUpdate({
        chatId: `chat-${suffix}`,
        title: `Operator ${suffix}`,
        text: "/stop",
      });
      await waitForSentMessage(harness, (text) => text.includes("Stopped supervisor activity."));

      const sessions = await invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions");
      expect(sessions.filter((entry) => entry.title.includes("Supervisor main session"))).toHaveLength(1);

      await clickSelector(sessionId, '[data-role="channel-list"] .task-list-link');
      await waitForSelector(sessionId, '[data-role="channel-activity-list"]');
      await waitForText(sessionId, "/status");
      await waitForText(sessionId, "/project");
    } finally {
      await deleteWebdriverSession(sessionId);
      await harness.close();
    }
  }, 240_000);
});
ss, (text) => text.includes("Stopped supervisor activity."));

      const sessions = await invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions");
      expect(sessions.filter((entry) => entry.title.includes("Supervisor main session"))).toHaveLength(1);

      await clickSelector(sessionId, '[data-role="channel-list"] .task-list-link');
      await waitForSelector(sessionId, '[data-role="channel-activity-list"]');
      await waitForText(sessionId, "/status");
      await waitForText(sessionId, "/project");
    } finally {
      await deleteWebdriverSession(sessionId);
      await harness.close();
    }
  }, 240_000);
});
