export const REVIEW_TYPES = ["Правка", "Вопрос", "Удалить", "Переписать"];

export function splitPhysicalLines(text) {
  const value = String(text ?? "");
  const lines = [];
  const starts = [];
  const endings = [];
  const pattern = /\r\n|\n|\r/g;
  let start = 0;
  let match;

  while ((match = pattern.exec(value)) !== null) {
    starts.push(start);
    lines.push(value.slice(start, match.index));
    endings.push(match[0]);
    start = match.index + match[0].length;
  }

  starts.push(start);
  lines.push(value.slice(start));
  endings.push("");

  return { lines, starts, endings };
}

export function anchoredSortKey(entry) {
  return [
    entry.startLine,
    entry.startColumn,
    entry.endLine,
    entry.endColumn,
    entry.sequence,
  ];
}

export function compareKeys(left, right) {
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function compareBoundary(left, right) {
  if (left === "start") return right === "start" ? 0 : -1;
  if (right === "start") return 1;
  if (left === "end") return right === "end" ? 0 : 1;
  if (right === "end") return -1;
  return compareKeys(left, right);
}

export function compareReviewEntries(left, right) {
  if (left.kind === "anchored" && right.kind === "anchored") {
    return compareKeys(anchoredSortKey(left), anchoredSortKey(right));
  }

  if (left.kind === "free" && right.kind === "free") {
    const boundaryResult = compareBoundary(left.boundaryKey, right.boundaryKey);
    if (boundaryResult !== 0) return boundaryResult;
    if (left.freeOrder !== right.freeOrder) return left.freeOrder - right.freeOrder;
    return left.sequence - right.sequence;
  }

  const anchor = left.kind === "anchored" ? left : right;
  const free = left.kind === "free" ? left : right;
  let anchorBeforeFree;

  if (free.boundaryKey === "start") anchorBeforeFree = false;
  else if (free.boundaryKey === "end") anchorBeforeFree = true;
  else anchorBeforeFree = compareKeys(anchoredSortKey(anchor), free.boundaryKey) <= 0;

  if (left.kind === "anchored") return anchorBeforeFree ? -1 : 1;
  return anchorBeforeFree ? 1 : -1;
}

export function orderReviewEntries(entries) {
  return [...entries].sort(compareReviewEntries);
}

export function boundaryAfter(entry) {
  if (!entry) return "end";
  if (entry.kind === "anchored") return anchoredSortKey(entry);
  return entry.boundaryKey;
}

export function nextFreeOrder(entries, boundaryKey, afterEntry = null) {
  const peers = entries
    .filter(
      (entry) =>
        entry.kind === "free" && compareBoundary(entry.boundaryKey, boundaryKey) === 0,
    )
    .sort((a, b) => a.freeOrder - b.freeOrder);

  if (afterEntry?.kind === "free") {
    const currentIndex = peers.findIndex((entry) => entry.id === afterEntry.id);
    const current = peers[currentIndex]?.freeOrder ?? 0;
    const next = peers[currentIndex + 1]?.freeOrder;
    return next === undefined ? current + 1 : current + (next - current) / 2;
  }

  return peers.length ? peers.at(-1).freeOrder + 1 : 1;
}

export function lineHeading(entry) {
  return entry.startLine === entry.endLine
    ? `Строка ${entry.startLine}`
    : `Строки ${entry.startLine}–${entry.endLine}`;
}

export function quoteBlock(quote) {
  return String(quote)
    .replace(/\r\n|\r/g, "\n")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

export function serializeEntry(entry) {
  if (entry.kind === "free") {
    return `### Общее замечание\n\n${entry.comment.trim()}`;
  }

  const parts = [
    `### ${lineHeading(entry)} · ${entry.type}`,
    quoteBlock(entry.quote),
    entry.comment.trim(),
  ];

  if (entry.replacement?.trim()) {
    const replacement = entry.replacement.trim();
    const [first, ...rest] = replacement.split(/\r\n|\r|\n/);
    parts.push(`**Заменить на:** ${first}${rest.length ? `\n${rest.join("\n")}` : ""}`);
  }

  return parts.join("\n\n");
}

export function serializeReview(entries) {
  const committed = entries.filter((entry) => entry.status !== "draft");
  if (!committed.length) return "";
  return `${orderReviewEntries(committed).map(serializeEntry).join("\n\n")}\n`;
}

export function countByType(entries) {
  return REVIEW_TYPES.reduce((counts, type) => {
    counts[type] = entries.filter(
      (entry) => entry.kind === "anchored" && entry.status !== "draft" && entry.type === type,
    ).length;
    return counts;
  }, {});
}

export function pluralizeReview(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} замечание`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} замечания`;
  }
  return `${count} замечаний`;
}
