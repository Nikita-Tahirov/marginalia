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

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

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
  const tokens = markdown.parse(text, env);
  return { tokens, env, ranges: topLevelRanges(tokens) };
}

export function renderTokenRange(plan, [from, to]) {
  return sanitizeToFragment(
    markdown.renderer.render(plan.tokens.slice(from, to), markdown.options, plan.env),
  );
}

export function renderMarkdown(text) {
  const env = { __seenLines: new Set(), __currentInlineLine: 1 };
  return sanitizeToFragment(markdown.render(text, env));
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
