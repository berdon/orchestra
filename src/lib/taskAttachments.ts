import type { TaskAttachmentInput, TaskAttachmentUploadInput } from "../types";

const ARCHIVE_MEDIA_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
]);

const AUDIO_FILE_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
];

const ARCHIVE_FILE_EXTENSIONS = [
  ".zip",
  ".tar",
  ".tgz",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
];

export type TaskAttachmentKind = "text" | "image" | "audio" | "archive" | "binary";

export function isBase64TaskAttachmentInput(input: TaskAttachmentUploadInput): input is TaskAttachmentInput {
  return typeof (input as TaskAttachmentInput).base64Data === "string";
}

export function encodeBytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function normalizeTaskAttachmentUploadInput(
  input: TaskAttachmentUploadInput,
): Promise<TaskAttachmentInput> {
  if (isBase64TaskAttachmentInput(input)) {
    return input;
  }

  const arrayBuffer = await input.file.arrayBuffer();
  return {
    fileName: input.fileName,
    mediaType: input.mediaType,
    base64Data: encodeBytesToBase64(new Uint8Array(arrayBuffer)),
    caption: input.caption ?? null,
  };
}

export function formatTaskAttachmentSize(byteSize: number) {
  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = byteSize;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const rounded = size >= 10 || unitIndex === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

export function getTaskAttachmentKind(mediaType: string, fileName?: string | null): TaskAttachmentKind {
  if (mediaType.startsWith("text/") || mediaType === "application/json") {
    return "text";
  }
  if (mediaType.startsWith("image/")) {
    return "image";
  }
  const normalizedFileName = fileName?.toLowerCase() ?? "";
  if (
    mediaType.startsWith("audio/") ||
    AUDIO_FILE_EXTENSIONS.some((extension) => normalizedFileName.endsWith(extension))
  ) {
    return "audio";
  }
  if (
    ARCHIVE_MEDIA_TYPES.has(mediaType) ||
    ARCHIVE_FILE_EXTENSIONS.some((extension) => normalizedFileName.endsWith(extension))
  ) {
    return "archive";
  }

  return "binary";
}

export function getTaskAttachmentFallbackCopy(kind: TaskAttachmentKind) {
  switch (kind) {
    case "audio":
      return {
        label: "Audio attachment",
        description: "Preview is intentionally skipped for audio files here. Download the file to listen locally.",
      };
    case "archive":
      return {
        label: "Archive attachment",
        description: "Archives are stored and downloadable as-is. Download the file to inspect its contents locally.",
      };
    case "binary":
      return {
        label: "Binary attachment",
        description: "This file type is stored without inline preview. Download it to inspect the original bytes locally.",
      };
    default:
      return {
        label: "Attachment",
        description: "Download this attachment to inspect it locally.",
      };
  }
}
