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

  const parts = [`### ${lineHeading(entry)} · ${entry.type}`, quoteBlock(entry.quote)];

  // Замечание без слов законно: тип и процитированные строки уже сказали, что
  // не так. Пустую часть в файл не пишем — иначе в тексте появится провал из
  // двух пустых строк там, где человек ничего не писал.
  const comment = entry.comment.trim();
  if (comment) parts.push(comment);

  if (entry.replacement?.trim()) {
    const replacement = entry.replacement.trim();
    const [first, ...rest] = replacement.split(/\r\n|\r|\n/);
    parts.push(`**Заменить на:** ${first}${rest.length ? `\n${rest.join("\n")}` : ""}`);
  }

  return parts.join("\n\n");
}

export const REVIEW_MARK = "marginalia";
export const REVIEW_MARK_VERSION = 1;

const MARK_PATTERN = /<!--\s*marginalia:(\d+)\s+([\s\S]*?)\s*-->\s*$/;

// Машинные поля прячем в HTML-комментарий: он невидим в любом просмотрщике
// Markdown, поэтому выгруженная рецензия остаётся такой же читаемой, как была.
function embedMark(payload) {
  const json = JSON.stringify(payload).replaceAll("--", "-\\u002d");
  return `<!-- ${REVIEW_MARK}:${REVIEW_MARK_VERSION} ${json} -->`;
}

export function serializeReview(entries, document = null) {
  const committed = entries.filter((entry) => entry.status !== "draft");
  if (!committed.length) return "";
  const ordered = orderReviewEntries(committed);
  const body = `${ordered.map(serializeEntry).join("\n\n")}\n`;
  if (!document) return body;
  return `${body}\n${embedMark({
    document: { name: document.name, sha256: document.sha256 },
    entries: ordered,
  })}\n`;
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseHeading(heading) {
  const general = heading.trim() === "Общее замечание";
  if (general) return { kind: "free" };
  const match = /^Строк[аи]\s+(\d+)(?:[–—-](\d+))?\s+·\s+(.+)$/.exec(heading.trim());
  if (!match) return null;
  const type = REVIEW_TYPES.includes(match[3].trim()) ? match[3].trim() : REVIEW_TYPES[0];
  const startLine = Number(match[1]);
  return { kind: "anchored", startLine, endLine: Number(match[2] ?? match[1]), type };
}

function parseBlock(block, index) {
  const lines = block.split("\n");
  const parsed = parseHeading(lines.shift() ?? "");
  if (!parsed) return null;

  while (lines.length && !lines[0].trim()) lines.shift();
  const quote = [];
  while (lines.length && /^>\s?/.test(lines[0])) quote.push(lines.shift().replace(/^>\s?/, ""));

  const rest = lines.join("\n").trim();
  const replacementAt = rest.indexOf("**Заменить на:** ");
  const comment = (replacementAt >= 0 ? rest.slice(0, replacementAt) : rest).trim();
  const replacement = replacementAt >= 0 ? rest.slice(replacementAt + 17).trim() : "";
  // Привязанное замечание опознано по заголовку «Строка N · Тип», поэтому
  // пустой комментарий его не отменяет — иначе рецензия, выгруженная с
  // бессловесными пометками, потеряла бы их при обратном чтении. Общая запись
  // без текста пуста целиком: такую и создать нельзя, значит это не запись.
  if (parsed.kind === "free" && !comment) return null;

  if (parsed.kind === "free") {
    return {
      kind: "free",
      status: "committed",
      comment,
      boundaryKey: "end",
      freeOrder: index + 1,
      sequence: index + 1,
    };
  }

  return {
    kind: "anchored",
    status: "committed",
    type: parsed.type,
    quote: quote.join("\n"),
    comment,
    replacement,
    startLine: parsed.startLine,
    startColumn: 0,
    endLine: parsed.endLine,
    endColumn: quote.join("\n").length,
    sequence: index + 1,
  };
}

// Файл рецензии приходит со стороны: его прислали письмом, скачали, передали
// вместе со статьёй. Машинный блок в нём — обычный JSON, и лежать там может что
// угодно: разметка вместо номера строки, чужой тип замечания, объект вместо
// текста. Поэтому запись не принимается как есть, а пересобирается по известной
// форме — всё, что в неё не укладывается, заменяется безопасным значением.
function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function plainText(value) {
  return typeof value === "string" ? value : "";
}

function boundaryKeyOf(value) {
  if (value === "start" || value === "end") return value;
  if (Array.isArray(value)) return value.map((item) => finiteNumber(item, 0));
  return "end";
}

export function normalizeEntry(entry, index = 0) {
  if (!entry || typeof entry !== "object") return null;
  const sequence = finiteNumber(entry.sequence, index + 1);

  if (entry.kind === "free") {
    const comment = plainText(entry.comment);
    // Общее замечание состоит из одного текста: пустое оно ничего не значит.
    if (!comment.trim()) return null;
    return {
      kind: "free",
      status: "committed",
      comment,
      boundaryKey: boundaryKeyOf(entry.boundaryKey),
      freeOrder: finiteNumber(entry.freeOrder, index + 1),
      sequence,
    };
  }

  // Всё, что не объявлено общим замечанием, считается привязанным: неизвестный
  // вид не должен получить собственную ветку отрисовки.
  const startLine = finiteNumber(entry.startLine, 1);
  return {
    kind: "anchored",
    status: "committed",
    type: REVIEW_TYPES.includes(entry.type) ? entry.type : REVIEW_TYPES[0],
    quote: plainText(entry.quote),
    comment: plainText(entry.comment),
    replacement: plainText(entry.replacement),
    startLine,
    startColumn: finiteNumber(entry.startColumn, 0),
    endLine: finiteNumber(entry.endLine, startLine),
    endColumn: finiteNumber(entry.endColumn, 0),
    sequence,
  };
}

export function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => normalizeEntry(entry, index)).filter(Boolean);
}

function normalizeMarkDocument(value) {
  if (!value || typeof value !== "object") return null;
  return { name: plainText(value.name), sha256: plainText(value.sha256) };
}

// Возвращает записи и, если рецензия выгружена этим приложением, документ, к
// которому она была написана. Машинный блок точен; разбор текста — запасной
// путь для файла, который человек правил руками.
export function parseReview(text) {
  const source = String(text ?? "");
  const mark = MARK_PATTERN.exec(source);
  if (mark) {
    try {
      const payload = JSON.parse(mark[2]);
      const entries = normalizeEntries(payload?.entries);
      if (entries.length) {
        return { document: normalizeMarkDocument(payload?.document), entries, origin: "mark" };
      }
    } catch {
      // Блок повреждён правкой руками — разбираем сам текст ниже.
    }
  }

  const body = mark ? source.slice(0, mark.index) : source;
  // Разобранный текст проходит ту же форму, что и машинный блок: два входа в
  // приложение не должны отличаться тем, насколько им верят.
  const entries = normalizeEntries(
    body
      .split(/\n(?=### )/)
      .map((block) => block.replace(/^### /, "").trim())
      .filter(Boolean)
      .map(parseBlock)
      .filter(Boolean),
  );

  return { document: null, entries, origin: entries.length ? "text" : "empty" };
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
