export function triggerBrowserDownload(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  queueMicrotask(() => {
    URL.revokeObjectURL(objectUrl);
  });
}

export function decodeBase64ToBytes(base64Data: string) {
  const decoded = atob(base64Data);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

export function createDownloadBlob(base64Data: string, mediaType: string) {
  return new Blob([decodeBase64ToBytes(base64Data)], {
    type: mediaType || "application/octet-stream",
  });
}
