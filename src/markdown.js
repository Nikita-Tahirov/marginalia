import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function lineSpan(line, env) {
  env.__seenLines ??= new Set();
  const isOrigin = !env.__seenLines.has(line);
  env.__seenLines.add(line);
  return `<span class="source-line${isOrigin ? " line-origin" : ""}" data-source-line="${line}">`;
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

export function renderMarkdown(text) {
  const env = { __seenLines: new Set(), __currentInlineLine: 1 };
  const html = markdown.render(text, env);
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
    ALLOWED_ATTR: ["class", "data-source-line", "href", "rel", "target"],
  });

  for (const link of fragment.querySelectorAll("a")) {
    const href = safeHref(link.getAttribute("href"));
    if (!href) link.removeAttribute("href");
  }

  return fragment;
}
