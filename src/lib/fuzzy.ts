export interface FuzzySearchCandidate {
  id: string;
  label: string;
  keywords?: string[];
}

export interface FuzzySearchMatch<T extends FuzzySearchCandidate> {
  item: T;
  score: number;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function scoreText(query: string, text: string) {
  if (!query || !text) {
    return 0;
  }

  if (text === query) {
    return 200;
  }

  if (text.startsWith(query)) {
    return 140 - Math.min(text.length - query.length, 20);
  }

  const wordIndex = text.indexOf(` ${query}`);
  if (wordIndex >= 0) {
    return 110 - Math.min(wordIndex, 30);
  }

  const substringIndex = text.indexOf(query);
  if (substringIndex >= 0) {
    return 90 - Math.min(substringIndex, 40);
  }

  let queryIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let index = 0; index < text.length && queryIndex < query.length; index += 1) {
    if (text[index] === query[queryIndex]) {
      if (firstMatch === -1) {
        firstMatch = index;
      }
      lastMatch = index;
      queryIndex += 1;
    }
  }

  if (queryIndex !== query.length || firstMatch === -1 || lastMatch === -1) {
    return -1;
  }

  const span = lastMatch - firstMatch + 1;
  const compactnessBonus = Math.max(0, 50 - span);
  const positionBonus = Math.max(0, 25 - firstMatch);
  return 40 + compactnessBonus + positionBonus;
}

export function fuzzyScore(query: string, candidate: FuzzySearchCandidate) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return 0;
  }

  const labelScore = scoreText(normalizedQuery, normalize(candidate.label));
  const keywordScore = Math.max(
    ...((candidate.keywords ?? []).map((keyword) => scoreText(normalizedQuery, normalize(keyword))) || [-1]),
  );
  return Math.max(labelScore, keywordScore);
}

export function fuzzySearch<T extends FuzzySearchCandidate>(query: string, items: T[], limit = 12): Array<FuzzySearchMatch<T>> {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return items.slice(0, limit).map((item, index) => ({ item, score: limit - index }));
  }

  return items
    .map((item) => ({ item, score: fuzzyScore(normalizedQuery, item) }))
    .filter((match) => match.score >= 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.item.label.localeCompare(right.item.label);
    })
    .slice(0, limit);
}
