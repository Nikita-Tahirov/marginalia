import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Роль, доступное имя и место в обходе клавиатурой пишутся сразу в разметку.
// Расставлять их обходом готового дерева значило бы тронуть по три атрибута у
// каждой из десяти тысяч строк уже после того, как документ показан человеку, —
// и до конца этого обхода экран стоит.
function lineSpan(line, env) {
  env.__seenLines ??= new Set();
  const isOrigin = !env.__seenLines.has(line);
  env.__seenLines.add(line);
  if (!isOrigin) return `<span class="source-line" data-source-line="${line}">`;
  return `<span class="source-line line-origin" data-source-line="${line}" tabindex="0" role="button" aria-label="Строка ${line}. Нажмите Enter, чтобы процитировать всю строку.">`;
}

function safeHref(value) {
  if (!value) return null;
  if (value.startsWith("#")) return value;
  try {
    const parsed = new URL(value, window.location.href);
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) return value;
  } catch {
    return null;
  }
  return null;
}

export const NBSP = " ";

// Висячий предлог — короткое слово, которое перенос по ширине оставляет в
// конце строки, оторвав от того, к чему оно относится. Список тот же, что в
// типографике слайдов и в сборке диссертации: 37 предлогов, союзов и частиц,
// после которых пробел становится неразрывным.
const HANGING = [
  "в", "к", "с", "у", "о", "а", "и", "я",
  "во", "на", "за", "по", "до", "из", "от", "об", "со", "ко",
  "не", "ни", "но", "да", "же", "ли", "бы",
  "при", "про", "под", "над", "без", "для", "ещё", "или", "что", "как", "так", "это",
];

// Хвост ловится только настоящим пробелом и табуляцией, а не \s: иначе на
// втором проходе предлог заново съедает уже поставленный неразрывный пробел
// как свой хвост и не отдаёт его соседу. Ведущая граница, наоборот, широкая —
// чтобы второй проход мог начаться сразу за вставленным пробелом.
const HANGING_PATTERN = new RegExp(`(\\s|^|[([«"'])(${HANGING.join("|")})[ \\t]+`, "gi");

const UPPER = "A-ZА-ЯЁ";
const LOWER = "a-zа-яё";

// «А. Ф. Лосев»: сначала разводят сами инициалы между собой, иначе следующая
// замена свяжет с фамилией только последний из них, а первый останется на
// разрывном пробеле и оторвётся переносом.
const INITIALS = new RegExp(`([${UPPER}]\\.) ([${UPPER}]\\.)`, "g");
const INITIALS_SURNAME = new RegExp(
  `([${UPPER}][${LOWER}]?(?:\\.-[${UPPER}][${LOWER}]?)?(?:\\.\\s?[${UPPER}][${LOWER}]?)?\\.) ([${UPPER}][${LOWER}])`,
  "g",
);

export function bindShortWords(text) {
  let bound = text.replace(INITIALS, `$1${NBSP}$2`).replace(INITIALS_SURNAME, `$1${NBSP}$2`);
  // Два прохода: в цепочке из двух предлогов подряд («но в другом») первый
  // забирает хвостовой пробел вместе с собой, и второй достаётся уже
  // следующему проходу.
  bound = bound.replace(HANGING_PATTERN, `$1$2${NBSP}`);
  return bound.replace(HANGING_PATTERN, `$1$2${NBSP}`);
}

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

// Правило текстового токена — единственное место, где видно, что именно
// читатель прочтёт как прозу: код в обратных кавычках, содержимое блоков и
// адрес ссылки живут в своих токенах и сюда не попадают. Обход готового DOM
// дал бы то же самое ценой прохода по всем строкам документа — тем самым,
// который однажды подвесил экран. Неразрывный пробел заменяет обычный, не
// меняя длину строки, поэтому номера строк остаются на своих местах.
markdown.renderer.rules.text = (tokens, index) =>
  escapeHtml(bindShortWords(tokens[index].content));

markdown.renderer.render = function renderWithPhysicalLines(tokens, options, env) {
  let result = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "inline") {
      const line = (token.map?.[0] ?? 0) + 1;
      env.__currentInlineLine = line;
      result += `${lineSpan(line, env)}${this.renderInline(token.children ?? [], options, env)}</span>`;
    } else if (this.rules[token.type]) {
      result += this.rules[token.type](tokens, index, options, env, this);
    } else {
      result += this.renderToken(tokens, index, options, env);
    }
  }
  return result;
};

markdown.renderer.rules.softbreak = (_tokens, _index, _options, env) => {
  env.__currentInlineLine += 1;
  return `</span><br>${lineSpan(env.__currentInlineLine, env)}`;
};

markdown.renderer.rules.image = (tokens, index) => {
  const alt = tokens[index].content?.trim() || "без подписи";
  return `<span class="image-placeholder">[Изображение: ${escapeHtml(alt)}]</span>`;
};

markdown.renderer.rules.link_open = (tokens, index, _options, _env, renderer) => {
  const token = tokens[index];
  const hrefIndex = token.attrIndex("href");
  const href = hrefIndex >= 0 ? safeHref(token.attrs[hrefIndex][1]) : null;
  if (!href && hrefIndex >= 0) token.attrs.splice(hrefIndex, 1);
  if (href?.startsWith("http")) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return renderer.renderToken(tokens, index, {});
};

markdown.renderer.rules.fence = (tokens, index, _options, env) => {
  const token = tokens[index];
  const startLine = (token.map?.[0] ?? 0) + 2;
  const rawLines = token.content.replace(/\n$/, "").split("\n");
  const lines = rawLines
    .map((line, offset) => `${lineSpan(startLine + offset, env)}${escapeHtml(line) || "&#8203;"}</span>`)
    .join("\n");
  const language = token.info?.trim().split(/\s+/)[0];
  const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre><code${languageClass}>${lines}</code></pre>\n`;
};

markdown.renderer.rules.code_block = (tokens, index, _options, env) => {
  const token = tokens[index];
  const startLine = (token.map?.[0] ?? 0) + 1;
  const rawLines = token.content.replace(/\n$/, "").split("\n");
  const lines = rawLines
    .map((line, offset) => `${lineSpan(startLine + offset, env)}${escapeHtml(line) || "&#8203;"}</span>`)
    .join("\n");
  return `<pre><code>${lines}</code></pre>\n`;
};

markdown.renderer.rules.hr = (tokens, index, _options, env) => {
  const line = (tokens[index].map?.[0] ?? 0) + 1;
  return `<div class="thematic-line">${lineSpan(line, env)}<hr></span></div>`;
};

// Вводная часть — служебные поля файла, а не текст статьи: вычитывают не их.
// markdown-it о ней не знает и читает закрывающие «---» как подчёркивание
// заголовка, поэтому метаданные попадали и в текст, и в оглавление — крупным
// заголовком поверх настоящего.
//
// Строки не удаляются, а заменяются пустыми: на номерах физических строк
// держится вся привязка замечаний, и сдвиг на длину вводной части увёл бы
// каждую уже написанную рецензию мимо своего места.
const FRONT_MATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/;

export function stripFrontMatter(text) {
  const source = String(text ?? "");
  const match = FRONT_MATTER.exec(source);
  if (!match) return source;
  const lines = match[0].split(/\r\n|\r|\n/).length;
  return "\n".repeat(lines - 1) + source.slice(match[0].length);
}

// Границы блоков верхнего уровня: место, где вложенность вернулась к нулю.
// По ним документ можно собирать частями, не разрезая ни абзац, ни таблицу.
function topLevelRanges(tokens) {
  const ranges = [];
  let depth = 0;
  let start = 0;
  tokens.forEach((token, index) => {
    depth += token.nesting;
    if (depth === 0) {
      ranges.push([start, index + 1]);
      start = index + 1;
    }
  });
  if (start < tokens.length) ranges.push([start, tokens.length]);
  return ranges;
}

// Разбор всего текста разом остаётся: резать сам markdown по кускам нельзя —
// ссылочные определения и сноски живут во всём документе сразу, и текст,
// разобранный по частям, вышел бы другим. Делится только то, что можно делить
// без последствий: превращение уже разобранных блоков в узлы страницы.
export function planMarkdown(text) {
  const env = { __seenLines: new Set(), __currentInlineLine: 1 };
  const tokens = markdown.parse(stripFrontMatter(text), env);
  return { tokens, env, ranges: topLevelRanges(tokens) };
}

export function renderTokenRange(plan, [from, to]) {
  return sanitizeToFragment(
    markdown.renderer.render(plan.tokens.slice(from, to), markdown.options, plan.env),
  );
}

export function renderMarkdown(text) {
  const env = { __seenLines: new Set(), __currentInlineLine: 1 };
  return sanitizeToFragment(markdown.render(stripFrontMatter(text), env));
}

function sanitizeToFragment(html) {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    SANITIZE_NAMED_PROPS: true,
    ALLOWED_TAGS: [
      "a",
      "blockquote",
      "br",
      "code",
      "del",
      "div",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "li",
      "ol",
      "p",
      "pre",
      "span",
      "strong",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ],
    ALLOWED_ATTR: [
      "aria-label",
      "class",
      "data-source-line",
      "href",
      "rel",
      "role",
      "tabindex",
      "target",
    ],
  });

  for (const link of fragment.querySelectorAll("a")) {
    const href = safeHref(link.getAttribute("href"));
    if (!href) link.removeAttribute("href");
  }

  return fragment;
}
