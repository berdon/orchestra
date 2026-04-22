export const TASK_TAG_MAX_COUNT = 20;
export const TASK_TAG_MAX_LENGTH = 32;

export const TASK_TAG_SYNTAX_ERROR = "Tags must use lower-case letters, numbers, - or _, and must start and end with a letter or number.";
export const TASK_TAG_LENGTH_ERROR = `Tags must be ${TASK_TAG_MAX_LENGTH} characters or fewer.`;
export const TASK_TAG_COUNT_ERROR = `A task may not have more than ${TASK_TAG_MAX_COUNT} tags.`;

const TASK_TAG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

export interface TaskTagCommitSuccess {
  ok: true;
  tags: string[];
  added: string[];
}

export interface TaskTagCommitFailure {
  ok: false;
  error: string;
}

export type TaskTagCommitResult = TaskTagCommitSuccess | TaskTagCommitFailure;

function sortTaskTags(tags: Iterable<string>) {
  return [...tags].sort((left, right) => left.localeCompare(right));
}

export function normalizeTaskTagCandidate(value: string) {
  return value.trim().toLowerCase();
}

export function normalizeTaskTags(tags: Iterable<string | null | undefined>) {
  const uniqueTags = new Set<string>();

  for (const tag of tags) {
    const normalized = normalizeTaskTagCandidate(tag ?? "");
    if (!normalized) {
      continue;
    }
    uniqueTags.add(normalized);
  }

  return sortTaskTags(uniqueTags);
}

export function splitTaskTagPaste(value: string) {
  return value.split(/[\n\r,]+/g);
}

export function validateTaskTag(tag: string) {
  if (!tag) {
    return null;
  }
  if (tag.length > TASK_TAG_MAX_LENGTH) {
    return TASK_TAG_LENGTH_ERROR;
  }
  if (!TASK_TAG_PATTERN.test(tag)) {
    return TASK_TAG_SYNTAX_ERROR;
  }
  return null;
}

export function validateTaskTagSet(tags: Iterable<string | null | undefined>) {
  const normalizedTags = normalizeTaskTags(tags);
  if (normalizedTags.length > TASK_TAG_MAX_COUNT) {
    return TASK_TAG_COUNT_ERROR;
  }
  for (const tag of normalizedTags) {
    const error = validateTaskTag(tag);
    if (error) {
      return error;
    }
  }
  return null;
}

export function commitTaskTagCandidates(existingTags: Iterable<string | null | undefined>, rawCandidates: Iterable<string | null | undefined>): TaskTagCommitResult {
  const normalizedExistingTags = normalizeTaskTags(existingTags);
  const incomingTags: string[] = [];

  for (const candidate of rawCandidates) {
    const normalized = normalizeTaskTagCandidate(candidate ?? "");
    if (!normalized) {
      continue;
    }
    const error = validateTaskTag(normalized);
    if (error) {
      return { ok: false, error };
    }
    incomingTags.push(normalized);
  }

  const existingTagSet = new Set(normalizedExistingTags);
  const mergedTags = new Set(normalizedExistingTags);
  for (const tag of incomingTags) {
    mergedTags.add(tag);
  }

  const nextTags = sortTaskTags(mergedTags);
  if (nextTags.length > TASK_TAG_MAX_COUNT) {
    return { ok: false, error: TASK_TAG_COUNT_ERROR };
  }

  return {
    ok: true,
    tags: nextTags,
    added: nextTags.filter((tag) => !existingTagSet.has(tag)),
  };
}
