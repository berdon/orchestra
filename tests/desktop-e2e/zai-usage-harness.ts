import http from "node:http";

type QuotaState = {
  rolling5hPercent: number;
  weeklyPercent: number;
};

export type ZaiUsageHarness = {
  apiBaseUrl: string;
  providerBaseUrl: string;
  setQuota: (input: Partial<QuotaState>) => void;
  stop: () => Promise<void>;
};

function quotaResponse(state: QuotaState) {
  return {
    code: 200,
    success: true,
    data: {
      level: "pro",
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          percentage: state.rolling5hPercent,
          currentValue: state.rolling5hPercent,
          usage: 100,
          nextResetTime: "2026-05-02T03:00:00Z",
          usageDetails: [{ modelCode: "glm-4.6", usage: state.rolling5hPercent }],
        },
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          percentage: state.weeklyPercent,
          currentValue: state.weeklyPercent,
          usage: 100,
          nextResetTime: "2026-05-08T03:00:00Z",
          usageDetails: [{ modelCode: "glm-4.6", usage: state.weeklyPercent }],
        },
      ],
    },
  };
}

async function readRequestBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startZaiUsageHarness(initialQuota: QuotaState = { rolling5hPercent: 20, weeklyPercent: 20 }): Promise<ZaiUsageHarness> {
  const quota = { ...initialQuota };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/api/monitor/usage/quota/limit") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(quotaResponse(quota)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/v1/chat/completions") {
      const body = await readRequestBody(request);
      const parsed = body ? JSON.parse(body) as { model?: string } : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-zai-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1_000),
        model: parsed.model ?? "glm-4.6",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Mock Z.ai response",
            },
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 4,
          total_tokens: 9,
        },
      }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `Unhandled mock path ${request.method} ${url.pathname}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve Z.ai harness address.");
  }

  const apiBaseUrl = `http://127.0.0.1:${address.port}/api`;
  return {
    apiBaseUrl,
    providerBaseUrl: `${apiBaseUrl}/v1`,
    setQuota(input) {
      if (typeof input.rolling5hPercent === "number") {
        quota.rolling5hPercent = input.rolling5hPercent;
      }
      if (typeof input.weeklyPercent === "number") {
        quota.weeklyPercent = input.weeklyPercent;
      }
    },
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
