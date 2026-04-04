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
import {
  createTelegramHarness,
  HarnessCallbackAnswer,
  HarnessSentMessage,
} from "./telegram-harness";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function waitForCondition<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}

async function waitForSentMessage(
  harness: Awaited<ReturnType<typeof createTelegramHarness>>,
  matcher: (message: HarnessSentMessage) => boolean,
  timeoutMs = 90_000,
) {
  const messages = await waitForCondition(() => harness.listSentMessages(), (value) => value.some(matcher), timeoutMs);
  const match = [...messages].reverse().find(matcher);
  if (!match) {
    throw new Error(`Expected matching message but none found: ${JSON.stringify(messages)}`);
  }
  return match;
}

async function waitForCallbackAnswer(
  harness: Awaited<ReturnType<typeof createTelegramHarness>>,
  matcher: (answer: HarnessCallbackAnswer) => boolean,
  timeoutMs = 90_000,
) {
  const answers = await waitForCondition(() => harness.listCallbackAnswers(), (value) => value.some(matcher), timeoutMs);
  const match = [...answers].reverse().find(matcher);
  if (!match) {
    throw new Error(`Expected matching callback answer but none found: ${JSON.stringify(answers)}`);
  }
  return match;
}

function findInlineButtonCallbackData(message: HarnessSentMessage, label: string) {
  const replyMarkup = message.reply_markup as {
    inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
  } | null;
  const rows = replyMarkup?.inline_keyboard ?? [];
  for (const row of rows) {
    for (const button of row) {
      if ((button.text ?? "").includes(label) && button.callback_data) {
        return button.callback_data;
      }
    }
  }
  return null;
}

describe("desktop channels telegram flow", () => {
  it.skipIf(!isDesktopE2E)("supports Telegram project switching buttons and task commands on the canonical supervisor session", async () => {
    const harness = await createTelegramHarness();
    const sessionId = await createReadyWebdriverSession();
    const suffix = Date.now().toString(36);
    const chatId = `chat-${suffix}`;
    const chatTitle = `Operator ${suffix}`;
    const secondProjectName = `ChannelSecondary${suffix}`;
    const taskTitle = `Telegram task ${suffix}`;

    try {
      await ensureReactReady(sessionId);

      const secondProject = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: { name: secondProjectName, description: "Second project for Telegram command routing" },
      });
      await invokeCommand(sessionId, "create_task", {
        projectId: secondProject.id,
        input: {
          title: taskTitle,
          description: "Task created for Telegram command coverage.",
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
        },
      });

      const models = await invokeCommand<Array<{ id: string; provider: string }>>(sessionId, "list_pi_models");
      const model = models[0];
      expect(model).toBeTruthy();

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, '[role="tab"]', "Channels");
      await clickSelector(sessionId, '[data-role="new-channel"]');
      await setInputValue(sessionId, '[data-role="channel-name"]', `Telegram Ops ${suffix}`);
      await selectValue(sessionId, '[data-role="channel-default-project"]', "orchestra");
      await setInputValue(sessionId, '[data-role="telegram-bot-token"]', harness.botToken);
      await setInputValue(sessionId, '[data-role="telegram-api-base-url"]', harness.apiBaseUrl);
      await clickSelector(sessionId, '[data-role="validate-telegram-bot"]');
      await waitForText(sessionId, "@orchestra_test_bot");

      await harness.pushUpdate({ chatId, title: chatTitle, text: "/start" });
      await clickSelector(sessionId, '[data-role="detect-telegram-chats"]');
      await waitForSelectOption(sessionId, '[data-role="telegram-chat-select"]', { value: chatId });
      await selectValue(sessionId, '[data-role="telegram-chat-select"]', chatId);
      await clickSelector(sessionId, '[data-role="channel-enabled"]');
      await clickSelector(sessionId, '[data-role="save-channel"]');
      await waitForText(sessionId, `Telegram Ops ${suffix}`);
      await waitForSentMessage(harness, (message) => message.text.includes("Plain text messages are delivered to the supervisor"));

      await harness.pushUpdate({ chatId, title: chatTitle, text: `/model ${model.provider}/${model.id}` });
      await waitForSentMessage(harness, (message) => message.text.includes(`Model changed to ${model.provider}/${model.id}.`));

      await harness.pushUpdate({ chatId, title: chatTitle, text: "/projects" });
      const projectsMessage = await waitForSentMessage(
        harness,
        (message) => message.text.includes("Choose the default project for this Telegram channel:"),
      );
      const callbackData = findInlineButtonCallbackData(projectsMessage, secondProjectName);
      expect(callbackData).toBeTruthy();

      await harness.pushCallback({
        chatId,
        title: chatTitle,
        messageId: projectsMessage.message_id,
        data: callbackData!,
      });
      await waitForCallbackAnswer(harness, (answer) => answer.text.includes(`Default project set to ${secondProjectName}.`));
      await waitForSentMessage(harness, (message) => message.text.includes(`Default project set to ${secondProjectName}.`));

      await harness.pushUpdate({ chatId, title: chatTitle, text: "/status" });
      await waitForSentMessage(harness, (message) => message.text.includes(`Default project: ${secondProjectName}`));

      await harness.pushUpdate({ chatId, title: chatTitle, text: "/tasks" });
      await waitForSentMessage(
        harness,
        (message) => message.text.includes(`Tasks for ${secondProjectName}:`) && message.text.includes(taskTitle),
      );

      await harness.pushUpdate({ chatId, title: chatTitle, text: "/task ORC-1" });
      await waitForSentMessage(
        harness,
        (message) => message.text.includes("ORC-1") && message.text.includes(taskTitle) && message.text.includes(`Project: ${secondProjectName}`),
      );

      const sessions = await invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions");
      expect(sessions.filter((entry) => entry.title.includes("Supervisor main session"))).toHaveLength(1);

      await clickSelector(sessionId, '[data-role="channel-list"] .task-list-link');
      await waitForSelector(sessionId, '[data-role="channel-activity-list"]');
      await waitForText(sessionId, "/start");
    } finally {
      await deleteWebdriverSession(sessionId);
      await harness.close();
    }
  }, 300_000);
});
