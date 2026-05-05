const DEFAULT_PLAYWRIGHT_WEB_HOST = "127.0.0.1";
const DEFAULT_PLAYWRIGHT_WEB_PORT = 4176;

function parsePort(rawValue: string | undefined) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PLAYWRIGHT_WEB_PORT;
}

export const PLAYWRIGHT_WEB_HOST = process.env.PLAYWRIGHT_WEB_HOST || DEFAULT_PLAYWRIGHT_WEB_HOST;
export const PLAYWRIGHT_WEB_PORT = parsePort(process.env.PLAYWRIGHT_WEB_PORT);
export const PLAYWRIGHT_WEB_URL = `http://${PLAYWRIGHT_WEB_HOST}:${PLAYWRIGHT_WEB_PORT}`;
