import hljs from "highlight.js";

const FILE_NAME_LANGUAGE_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  justfile: "makefile",
  procfile: "bash",
  gemfile: "ruby",
  rakefile: "ruby",
  brewfile: "ruby",
  podfile: "ruby",
  readme: "markdown",
  license: "plaintext",
};

const FILE_EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  env: "bash",
  xml: "xml",
  svg: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  txt: "plaintext",
  log: "plaintext",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
};

const MEDIA_TYPE_LANGUAGE_MAP: Record<string, string> = {
  "application/json": "json",
  "application/ld+json": "json",
  "application/xml": "xml",
  "application/rss+xml": "xml",
  "application/atom+xml": "xml",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/toml": "toml",
  "application/x-toml": "toml",
  "application/sql": "sql",
  "application/graphql": "graphql",
  "application/javascript": "javascript",
  "application/x-javascript": "javascript",
  "application/typescript": "typescript",
  "application/x-sh": "bash",
  "application/x-shellscript": "bash",
};

function normalizeMediaType(mediaType?: string | null) {
  return mediaType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function detectCodeLanguage(fileName: string, mediaType?: string | null): string {
  const normalizedMediaType = normalizeMediaType(mediaType);
  if (normalizedMediaType && MEDIA_TYPE_LANGUAGE_MAP[normalizedMediaType]) {
    return MEDIA_TYPE_LANGUAGE_MAP[normalizedMediaType];
  }
  if (normalizedMediaType.endsWith("+json")) {
    return "json";
  }
  if (normalizedMediaType.endsWith("+xml")) {
    return "xml";
  }
  if (normalizedMediaType.endsWith("+yaml")) {
    return "yaml";
  }

  const normalizedFileName = fileName.split("/").pop()?.trim().toLowerCase() ?? "";
  if (!normalizedFileName) {
    return "plaintext";
  }

  if (FILE_NAME_LANGUAGE_MAP[normalizedFileName]) {
    return FILE_NAME_LANGUAGE_MAP[normalizedFileName];
  }

  const extension = normalizedFileName.split(".").pop()?.toLowerCase() ?? "";
  if (FILE_EXTENSION_LANGUAGE_MAP[extension]) {
    return FILE_EXTENSION_LANGUAGE_MAP[extension];
  }

  return "plaintext";
}

export function highlightCode(code: string, language: string) {
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

export function shouldSyntaxHighlightText(byteSize: number, maxByteSize = 256 * 1024) {
  return Number.isFinite(byteSize) && byteSize > 0 && byteSize <= maxByteSize;
}
