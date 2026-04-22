export const TASK_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;
const TASK_NUMBER_PATTERN = /^([A-Za-z][A-Za-z0-9]*)-([0-9]+)(.*)$/;
const MAX_TASK_PREFIX_LENGTH = 8;
const MIN_TASK_PREFIX_LENGTH = 2;

function sanitizeTaskPrefixCharacters(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function ensurePrefixShape(value: string) {
  let candidate = sanitizeTaskPrefixCharacters(value);
  if (!candidate) {
    candidate = "PR";
  }
  if (!/^[A-Z]/.test(candidate)) {
    candidate = `P${candidate}`;
  }
  if (candidate.length < MIN_TASK_PREFIX_LENGTH) {
    candidate = `${candidate}X`;
  }
  return candidate.slice(0, MAX_TASK_PREFIX_LENGTH);
}

function buildSuggestedTaskPrefixBase(name: string) {
  const words = name
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .map((word) => sanitizeTaskPrefixCharacters(word))
    .filter(Boolean);

  let candidate = words.length > 1
    ? words.map((word) => word[0] ?? "").join("")
    : sanitizeTaskPrefixCharacters(name).slice(0, 3);

  if (candidate.length < MIN_TASK_PREFIX_LENGTH) {
    candidate = sanitizeTaskPrefixCharacters(name);
  }

  return ensurePrefixShape(candidate);
}

function nextAvailableTaskPrefix(base: string, existingPrefixes: Set<string>) {
  const normalizedBase = ensurePrefixShape(base);
  let candidate = normalizedBase;
  let suffix = 2;

  while (existingPrefixes.has(candidate)) {
    const suffixText = String(suffix);
    const trimmedBase = normalizedBase.slice(0, Math.max(1, MAX_TASK_PREFIX_LENGTH - suffixText.length));
    candidate = ensurePrefixShape(`${trimmedBase}${suffixText}`);
    suffix += 1;
  }

  return candidate;
}

export function normalizeTaskPrefix(value?: string | null) {
  return (value ?? "").trim().toUpperCase();
}

export function validateTaskPrefix(value?: string | null) {
  const normalized = normalizeTaskPrefix(value);
  if (!normalized) {
    return "Task prefix is required.";
  }
  if (!TASK_PREFIX_PATTERN.test(normalized)) {
    return "Task prefix must start with a letter and contain only A-Z or 0-9.";
  }
  return null;
}

export function suggestTaskPrefix(name: string, existingPrefixes: Iterable<string> = []) {
  const usedPrefixes = new Set(Array.from(existingPrefixes, (value) => normalizeTaskPrefix(value)).filter(Boolean));
  return nextAvailableTaskPrefix(buildSuggestedTaskPrefixBase(name), usedPrefixes);
}

export function formatTaskNumber(taskPrefix: string, sequenceNumber: number) {
  return `${normalizeTaskPrefix(taskPrefix)}-${sequenceNumber}`;
}

export function parseTaskNumber(taskNumber?: string | null) {
  if (!taskNumber) {
    return { hasTask: false, prefix: "", sequence: Number.POSITIVE_INFINITY, suffix: "" };
  }

  const match = taskNumber.match(TASK_NUMBER_PATTERN);
  if (!match) {
    return { hasTask: true, prefix: taskNumber.toLowerCase(), sequence: Number.POSITIVE_INFINITY, suffix: "" };
  }

  return {
    hasTask: true,
    prefix: (match[1] ?? "").toLowerCase(),
    sequence: Number.parseInt(match[2] ?? "", 10),
    suffix: (match[3] ?? "").toLowerCase(),
  };
}
