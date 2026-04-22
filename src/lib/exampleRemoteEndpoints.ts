export const EXAMPLE_REMOTE_LAN_HOST = "192.0.2.10";
export const EXAMPLE_REMOTE_SECURE_HOST = "demo-device.invalid";

export function buildExampleRemoteLanBaseUrl(port: number) {
  return `http://${EXAMPLE_REMOTE_LAN_HOST}:${port}`;
}

export function buildExampleRemoteLanWebSocketUrl(port: number) {
  return `ws://${EXAMPLE_REMOTE_LAN_HOST}:${port}/api/v1/ws`;
}

export function buildExampleRemoteSecureBaseUrl(port: number) {
  return `https://${EXAMPLE_REMOTE_SECURE_HOST}:${port}`;
}

export const EXAMPLE_REMOTE_SECURE_WEB_URL = `https://${EXAMPLE_REMOTE_SECURE_HOST}:9443`;
