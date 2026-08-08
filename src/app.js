import {
  REVIEW_TYPES,
  anchoredSortKey,
  boundaryAfter,
  countByType,
  lineHeading,
  nextFreeOrder,
  orderReviewEntries,
  pluralizeReview,
  serializeReview,
  splitPhysicalLines,
} from "./core.js";
import { renderMarkdown } from "./markdown.js";
import "./panes.js";

const elements = {
  documentSelect: document.querySelector("#document-select"),
  openFiles: document.querySelector("#open-files"),
  openFilesEmpty: document.querySelector("#open-files-empty"),
  fileInput: document.querySelector("#file-input"),
  searchInput: document.querySelector("#search-input"),
  searchCounter: document.querySelector("#search-counter"),
  searchPrev: document.querySelector("#search-prev"),
  searchNext: document.querySelector("#search-next"),
  reviewCount: document.querySelector("#review-count"),
  copyReview: document.querySelector("#copy-review"),
  saveReview: document.querySelector("#save-review"),
  themeToggle: document.querySelector("#theme-toggle"),
  tocList: document.querySelector("#toc-list"),
  documentMeta: document.querySelector("#document-meta"),
  filterList: document.querySelector("#filter-list"),
  addGeneral: document.querySelector("#add-general"),
  reviewList: document.querySelector("#review-list"),
  previewReview: document.querySelector("#preview-review"),
  documentPane: document.querySelector("#document-pane"),
  documentEmpty: document.querySelector("#document-empty"),
  documentBody: document.querySelector("#document-body"),
  quoteToolbar: document.querySelector("#quote-toolbar"),
  toast: document.querySelector("#toast"),
  previewDialog: document.querySelector("#preview-dialog"),
  previewContent: document.querySelector("#preview-content"),
  closePreview: document.querySelector("#close-preview"),
};

const state = {
  documents: [],
  activeDocumentId: null,
  selectedTypes: new Set(REVIEW_TYPES),
  draft: null,
  pendingSelection: null,
  activeEntryId: null,
  searchResults: [],
  searchIndex: -1,
  toastTimer: null,
  theme: "light",
};

function activeDocument() {
  return state.documents.find((item) => item.id === state.activeDocumentId) ?? null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMultiline(value) {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function showToast(message, tone = "info") {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.tone = tone;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 4200);
}

function nextSequence(doc) {
  doc.sequence += 1;
  return doc.sequence;
}

function committedEntries(doc = activeDocument()) {
  return doc?.entries ?? [];
}

function allReviewEntries(doc = activeDocument()) {
  if (!doc) return [];
  return state.draft?.documentId === doc.id ? [...doc.entries, state.draft] : [...doc.entries];
}

function getExportText(doc = activeDocument()) {
  return serializeReview(doc?.entries ?? []);
}

function updateHeader() {
  const doc = activeDocument();
  elements.documentSelect.disabled = !state.documents.length;
  elements.searchInput.disabled = !doc;
  elements.addGeneral.disabled = !doc;

  elements.documentSelect.replaceChildren();
  if (!state.documents.length) {
    elements.documentSelect.append(new Option("Документ не открыт", ""));
  } else {
    for (const item of state.documents) {
      const count = item.lineData.lines.length;
      const option = new Option(`${item.name} · ${count} стр.`, item.id);
      option.selected = item.id === state.activeDocumentId;
      elements.documentSelect.append(option);
    }
  }

  const count = doc?.entries.length ?? 0;
  elements.reviewCount.textContent = pluralizeReview(count);
  elements.copyReview.disabled = !doc || count === 0;
  elements.saveReview.disabled = !doc || count === 0;
  elements.previewReview.disabled = !doc || count === 0;
}

const FILTER_ICONS = {
  Правка: "edit",
  Вопрос: "help",
  Удалить: "delete",
  Переписать: "autorenew",
};

function renderFilters() {
  const counts = countByType(committedEntries());
  elements.filterList.innerHTML = REVIEW_TYPES.map((type) => {
    const pressed = state.selectedTypes.has(type);
    return `<button
      class="filter-chip type-${type.toLowerCase()}${pressed ? " is-active" : ""}"
      type="button"
      data-filter-type="${type}"
      data-tooltip="${type}"
      aria-label="${type}"
      aria-pressed="${pressed}"
    ><span class="mi" aria-hidden="true">${FILTER_ICONS[type]}</span><span class="chip-count">${counts[type]}</span></button>`;
  }).join("");
}

function visibleOrderedEntries() {
  return orderReviewEntries(allReviewEntries()).filter((entry) => {
    if (entry.status === "draft" || entry.kind === "free") return true;
    return state.selectedTypes.has(entry.type);
  });
}

function typeClass(type) {
  return `type-${type.toLowerCase()}`;
}

function anchoredCard(entry) {
  const replacement = entry.replacement?.trim()
    ? `<div class="replacement"><span>Заменить на</span><p>${renderMultiline(entry.replacement.trim())}</p></div>`
    : "";
  const active = entry.id === state.activeEntryId ? " is-active" : "";
  return `<article class="review-card ${typeClass(entry.type)}${active}" data-entry-id="${entry.id}" tabindex="0">
    <header class="card-header">
      <span class="type-badge">${entry.type}</span>
      <button class="line-link" type="button" data-action="activate" data-entry-id="${entry.id}">${lineHeading(entry).toLowerCase()}</button>
      <button class="card-delete" type="button" data-action="delete" data-entry-id="${entry.id}" aria-label="Удалить замечание">×</button>
    </header>
    <blockquote>${renderMultiline(entry.quote)}</blockquote>
    <p class="card-comment">${renderMultiline(entry.comment)}</p>
    ${replacement}
    <footer class="card-actions">
      <button type="button" class="inline-action" data-action="add-general-after" data-entry-id="${entry.id}">+ Общее после</button>
    </footer>
  </article>`;
}

function freeCard(entry) {
  return `<article class="review-card free-card" data-entry-id="${entry.id}" tabindex="0">
    <header class="card-header">
      <span class="general-badge">Общее замечание</span>
      <span class="free-position">без строки</span>
      <button class="card-delete" type="button" data-action="delete" data-entry-id="${entry.id}" aria-label="Удалить общее замечание">×</button>
    </header>
    <p class="card-comment">${renderMultiline(entry.comment)}</p>
    <footer class="card-actions">
      <button type="button" class="inline-action" data-action="add-general-after" data-entry-id="${entry.id}">+ Общее после</button>
    </footer>
  </article>`;
}

function typeChoices(activeType) {
  return REVIEW_TYPES.map(
    (type) => `<button
      class="draft-type ${typeClass(type)}${type === activeType ? " is-active" : ""}"
      type="button"
      data-action="draft-type"
      data-type="${type}"
      aria-pressed="${type === activeType}"
    >${type}</button>`,
  ).join("");
}

function draftCard(entry) {
  const anchored = entry.kind === "anchored";
  return `<article class="review-card draft-card" data-entry-id="${entry.id}">
    <header class="draft-heading">
      <span>Новое ${anchored ? "замечание" : "общее замечание"}</span>
      <span>${anchored ? lineHeading(entry).toLowerCase() : "без строки"}</span>
    </header>
    ${anchored ? `<blockquote>${renderMultiline(entry.quote)}</blockquote><div class="draft-types" role="group" aria-label="Тип замечания">${typeChoices(entry.type)}</div>` : ""}
    <label class="draft-label" for="draft-comment">${anchored ? "Комментарий" : "Текст общего замечания"} <span aria-hidden="true">*</span></label>
    <textarea id="draft-comment" class="input draft-textarea" rows="4" required>${escapeHtml(entry.comment)}</textarea>
    ${anchored ? `<label class="draft-label" for="draft-replacement">Заменить на <span>по желанию</span></label><textarea id="draft-replacement" class="input draft-textarea replacement-input" rows="3">${escapeHtml(entry.replacement)}</textarea>` : ""}
    <p id="draft-error" class="draft-error" role="alert" hidden>Напишите комментарий.</p>
    <div class="draft-actions">
      <button class="btn btn-primary compact-btn" type="button" data-action="commit-draft">Добавить</button>
      <button class="btn btn-ghost compact-btn" type="button" data-action="cancel-draft">Отмена</button>
      <span>⌘/Ctrl+Enter</span>
    </div>
  </article>`;
}

function renderReview({ focusDraft = false } = {}) {
  const doc = activeDocument();
  if (!doc) {
    elements.reviewList.innerHTML = `<div class="empty-review"><p>Здесь появится рецензия.</p><span>Откройте Markdown-документ.</span></div>`;
    return;
  }

  const entries = visibleOrderedEntries();
  if (!entries.length) {
    const filtered = doc.entries.length > 0;
    elements.reviewList.innerHTML = `<div class="empty-review"><p>${filtered ? "Нет замечаний выбранных типов." : "Пока нет замечаний."}</p><span>${filtered ? "Измените фильтры выше." : "Выделите текст справа или добавьте общее замечание."}</span></div>`;
    return;
  }

  elements.reviewList.innerHTML = entries
    .map((entry) => {
      if (entry.status === "draft") return draftCard(entry);
      return entry.kind === "anchored" ? anchoredCard(entry) : freeCard(entry);
    })
    .join("");

  if (focusDraft) {
    requestAnimationFrame(() => {
      const field = elements.reviewList.querySelector("#draft-comment");
      field?.focus();
      field?.scrollIntoView({ block: "nearest" });
    });
  }
}

function renderToc() {
  const headings = [...elements.documentBody.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  elements.tocList.replaceChildren();
  if (!headings.length) {
    const empty = document.createElement("span");
    empty.className = "toc-empty";
    empty.textContent = "Без заголовков";
    elements.tocList.append(empty);
    return;
  }

  headings.forEach((heading, index) => {
    const line = heading.querySelector("[data-source-line]")?.dataset.sourceLine ?? index + 1;
    const id = `section-${line}-${index + 1}`;
    heading.id = id;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toc-item";
    button.dataset.target = id;
    button.textContent = heading.textContent.trim() || `Раздел ${index + 1}`;
    button.title = button.textContent;
    elements.tocList.append(button);
  });
}

function configureSourceLines() {
  const origins = [...elements.documentBody.querySelectorAll(".source-line.line-origin")];
  for (const span of origins) {
    const line = Number(span.dataset.sourceLine);
    span.tabIndex = 0;
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", `Строка ${line}. Нажмите Enter, чтобы процитировать всю строку.`);
  }
}

function renderDocument() {
  const doc = activeDocument();
  hideQuoteToolbar();
  elements.documentBody.replaceChildren();
  state.searchResults = [];
  state.searchIndex = -1;
  elements.searchInput.value = "";
  updateSearchCounter();

  if (!doc) {
    elements.documentBody.hidden = true;
    elements.documentEmpty.hidden = false;
    elements.tocList.innerHTML = `<span class="toc-empty">Откройте документ</span>`;
    elements.documentMeta.textContent = "";
    return;
  }

  elements.documentEmpty.hidden = true;
  elements.documentBody.hidden = false;
  if (doc.text.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rendered-empty";
    empty.textContent = "Документ пуст.";
    elements.documentBody.append(empty);
  } else {
    elements.documentBody.append(renderMarkdown(doc.text));
    configureSourceLines();
  }
  elements.documentMeta.textContent = `${doc.lineData.lines.length} строк`;
  renderToc();
  applyAnnotationMarkers();
}

function applyAnnotationMarkers() {
  const doc = activeDocument();
  const spans = [...elements.documentBody.querySelectorAll("[data-source-line]")];
  for (const span of spans) {
    span.classList.remove("is-annotated", "is-active-annotation");
    span.removeAttribute("data-annotation-count");
  }
  if (!doc) return;

  const counts = new Map();
  for (const entry of doc.entries.filter((item) => item.kind === "anchored")) {
    for (let line = entry.startLine; line <= entry.endLine; line += 1) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  for (const span of spans) {
    const line = Number(span.dataset.sourceLine);
    const count = counts.get(line) ?? 0;
    if (count) {
      span.classList.add("is-annotated");
      span.dataset.annotationCount = String(count);
    }
  }

  const active = doc.entries.find((entry) => entry.id === state.activeEntryId);
  if (active?.kind === "anchored") {
    for (const span of spans) {
      const line = Number(span.dataset.sourceLine);
      if (line >= active.startLine && line <= active.endLine) {
        span.classList.add("is-active-annotation");
      }
    }
  }
}

function refreshReviewState(options) {
  updateHeader();
  renderFilters();
  renderReview(options);
  applyAnnotationMarkers();
}

function activateDocument(id) {
  if (!state.documents.some((doc) => doc.id === id)) return;
  state.activeDocumentId = id;
  state.draft = null;
  state.pendingSelection = null;
  state.activeEntryId = null;
  state.selectedTypes = new Set(REVIEW_TYPES);
  updateHeader();
  renderFilters();
  renderReview();
  renderDocument();
}

async function loadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let lastLoaded = null;
  for (const file of files) {
    if (!/\.(md|markdown)$/i.test(file.name)) {
      showToast(`Файл «${file.name}» пропущен: нужен .md или .markdown.`, "error");
      continue;
    }
    try {
      const text = await file.text();
      const doc = {
        id: crypto.randomUUID(),
        name: file.name,
        text,
        lineData: splitPhysicalLines(text),
        entries: [],
        sequence: 0,
      };
      state.documents.push(doc);
      lastLoaded = doc;
    } catch (error) {
      showToast(`Не удалось прочитать «${file.name}»: ${error.message}`, "error");
    }
  }
  elements.fileInput.value = "";
  if (lastLoaded) {
    activateDocument(lastLoaded.id);
    showToast(`Открыт «${lastLoaded.name}».`);
  }
}

function sourceSpan(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return element?.closest?.(".source-line") ?? null;
}

function offsetInside(span, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(span);
  try {
    range.setEnd(container, offset);
    return range.toString().length;
  } catch {
    return 0;
  }
}

function cumulativeLineOffset(span, localOffset) {
  const line = span.dataset.sourceLine;
  const peers = [...elements.documentBody.querySelectorAll(`.source-line[data-source-line="${line}"]`)];
  const index = peers.indexOf(span);
  const preceding = peers.slice(0, Math.max(index, 0)).reduce((sum, item) => sum + item.textContent.length, 0);
  return preceding + localOffset;
}

function selectionInfo(range, quote) {
  const startSpan = sourceSpan(range.startContainer);
  const endSpan = sourceSpan(range.endContainer);
  if (!startSpan || !endSpan || !elements.documentBody.contains(startSpan) || !elements.documentBody.contains(endSpan)) {
    return null;
  }
  const startLine = Number(startSpan.dataset.sourceLine);
  const endLine = Number(endSpan.dataset.sourceLine);
  return {
    startLine,
    startColumn: cumulativeLineOffset(
      startSpan,
      offsetInside(startSpan, range.startContainer, range.startOffset),
    ),
    endLine,
    endColumn: cumulativeLineOffset(
      endSpan,
      offsetInside(endSpan, range.endContainer, range.endOffset),
    ),
    quote,
    rect: range.getBoundingClientRect(),
  };
}

function lineGroup(line) {
  return [...elements.documentBody.querySelectorAll(`.source-line[data-source-line="${line}"]`)];
}

function wholeLineSelection(span) {
  const line = Number(span.dataset.sourceLine);
  const peers = lineGroup(line);
  const quote = peers.map((item) => item.textContent).join("");
  return {
    startLine: line,
    startColumn: 0,
    endLine: line,
    endColumn: quote.length,
    quote,
    rect: span.getBoundingClientRect(),
  };
}

function showQuoteToolbar(info, focus = false) {
  if (!info?.quote?.trim()) return;
  state.pendingSelection = info;
  const paneRect = elements.documentPane.getBoundingClientRect();
  const left = Math.max(12, info.rect.left - paneRect.left + elements.documentPane.scrollLeft);
  const top = Math.max(12, info.rect.top - paneRect.top + elements.documentPane.scrollTop - 48);
  elements.quoteToolbar.style.left = `${left}px`;
  elements.quoteToolbar.style.top = `${top}px`;
  elements.quoteToolbar.hidden = false;
  if (focus) elements.quoteToolbar.querySelector("button")?.focus({ preventScroll: true });
}

function hideQuoteToolbar() {
  elements.quoteToolbar.hidden = true;
}

function handleDocumentScroll() {
  if (elements.quoteToolbar.contains(document.activeElement)) return;
  hideQuoteToolbar();
}

function handleSelection() {
  if (!activeDocument()) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const info = selectionInfo(range, selection.toString());
  if (info) showQuoteToolbar(info);
}

function createAnchoredDraft(type) {
  const doc = activeDocument();
  const selected = state.pendingSelection;
  if (!doc || !selected) return;
  state.draft = {
    id: crypto.randomUUID(),
    documentId: doc.id,
    kind: "anchored",
    status: "draft",
    type,
    quote: selected.quote,
    comment: "",
    replacement: "",
    startLine: selected.startLine,
    startColumn: selected.startColumn,
    endLine: selected.endLine,
    endColumn: selected.endColumn,
    sequence: nextSequence(doc),
  };
  window.getSelection()?.removeAllRanges();
  state.pendingSelection = null;
  hideQuoteToolbar();
  refreshReviewState({ focusDraft: true });
}

function createFreeDraft(afterEntry = null) {
  const doc = activeDocument();
  if (!doc) return;
  if (state.draft) {
    showToast("Сначала добавьте или отмените текущий черновик.", "error");
    elements.reviewList.querySelector("#draft-comment")?.focus();
    return;
  }
  const ordered = orderReviewEntries(doc.entries);
  const anchorEntry = afterEntry ?? ordered.at(-1) ?? null;
  const boundaryKey = boundaryAfter(anchorEntry);
  state.draft = {
    id: crypto.randomUUID(),
    documentId: doc.id,
    kind: "free",
    status: "draft",
    comment: "",
    boundaryKey,
    freeOrder: nextFreeOrder(doc.entries, boundaryKey, anchorEntry),
    sequence: nextSequence(doc),
  };
  refreshReviewState({ focusDraft: true });
}

function syncDraftFields() {
  if (!state.draft) return;
  const comment = elements.reviewList.querySelector("#draft-comment");
  const replacement = elements.reviewList.querySelector("#draft-replacement");
  if (comment) state.draft.comment = comment.value;
  if (replacement) state.draft.replacement = replacement.value;
}

function commitDraft() {
  const doc = activeDocument();
  if (!doc || !state.draft) return;
  syncDraftFields();
  if (!state.draft.comment.trim()) {
    const error = elements.reviewList.querySelector("#draft-error");
    if (error) error.hidden = false;
    elements.reviewList.querySelector("#draft-comment")?.focus();
    return;
  }
  const committed = { ...state.draft, status: "committed", comment: state.draft.comment.trim() };
  if (committed.kind === "anchored") committed.replacement = committed.replacement.trim();
  doc.entries.push(committed);
  state.draft = null;
  state.activeEntryId = committed.kind === "anchored" ? committed.id : null;
  refreshReviewState();
  showToast(committed.kind === "anchored" ? "Замечание добавлено." : "Общее замечание добавлено.");
}

function cancelDraft() {
  state.draft = null;
  refreshReviewState();
}

function deleteEntry(id) {
  const doc = activeDocument();
  if (!doc) return;
  const index = doc.entries.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  doc.entries.splice(index, 1);
  if (state.activeEntryId === id) state.activeEntryId = null;
  refreshReviewState();
  showToast("Запись удалена.");
}

function activateEntry(id) {
  const entry = activeDocument()?.entries.find((item) => item.id === id);
  if (!entry || entry.kind !== "anchored") return;
  state.activeEntryId = id;
  renderReview();
  applyAnnotationMarkers();
  const target = elements.documentBody.querySelector(`.source-line[data-source-line="${entry.startLine}"]`);
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function lineGroups() {
  const groups = new Map();
  for (const span of elements.documentBody.querySelectorAll(".source-line")) {
    const line = Number(span.dataset.sourceLine);
    if (!groups.has(line)) groups.set(line, []);
    groups.get(line).push(span);
  }
  return groups;
}

function clearSearchClasses() {
  for (const span of elements.documentBody.querySelectorAll(".source-line")) {
    span.classList.remove("is-search-hit", "is-current-search-hit");
  }
}

function runSearch(query) {
  clearSearchClasses();
  state.searchResults = [];
  state.searchIndex = -1;
  const needle = query.trim().toLocaleLowerCase("ru");
  if (!needle) {
    updateSearchCounter();
    return;
  }

  for (const [line, spans] of lineGroups()) {
    const text = spans.map((span) => span.textContent).join("");
    const haystack = text.toLocaleLowerCase("ru");
    let offset = 0;
    while ((offset = haystack.indexOf(needle, offset)) >= 0) {
      state.searchResults.push({ line, offset });
      offset += Math.max(needle.length, 1);
    }
    if (state.searchResults.some((result) => result.line === line)) {
      spans.forEach((span) => span.classList.add("is-search-hit"));
    }
  }
  if (state.searchResults.length) state.searchIndex = 0;
  showCurrentSearchResult(false);
}

function updateSearchCounter() {
  const total = state.searchResults.length;
  const current = total ? state.searchIndex + 1 : 0;
  elements.searchCounter.textContent = `${current} / ${total}`;
  elements.searchPrev.disabled = total === 0;
  elements.searchNext.disabled = total === 0;
}

function showCurrentSearchResult(scroll = true) {
  for (const span of elements.documentBody.querySelectorAll(".is-current-search-hit")) {
    span.classList.remove("is-current-search-hit");
  }
  const result = state.searchResults[state.searchIndex];
  if (result) {
    const spans = lineGroup(result.line);
    spans.forEach((span) => span.classList.add("is-current-search-hit"));
    if (scroll) spans[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  updateSearchCounter();
}

function navigateSearch(delta) {
  if (!state.searchResults.length) return;
  state.searchIndex =
    (state.searchIndex + delta + state.searchResults.length) % state.searchResults.length;
  showCurrentSearchResult();
}

async function copyReview() {
  const output = getExportText();
  if (!output) return;
  try {
    await navigator.clipboard.writeText(output);
    showToast("Рецензия скопирована.");
  } catch (error) {
    showToast(`Не удалось скопировать рецензию: ${error.message}`, "error");
  }
}

function reviewFilename(name) {
  const stem = name.replace(/\.(md|markdown)$/i, "") || "review";
  return `${stem}.review.md`;
}

function downloadReview(output, filename) {
  try {
    const blob = new Blob([output], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast("Рецензия сохранена.");
  } catch (error) {
    showToast(`Не удалось сохранить рецензию: ${error.message}`, "error");
  }
}

async function pickSaveTarget(filename) {
  if (typeof window.showSaveFilePicker !== "function") return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
    });
  } catch (error) {
    if (error.name === "AbortError") return "cancelled";
    return null;
  }
}

async function saveReview() {
  const doc = activeDocument();
  const output = getExportText(doc);
  if (!doc || !output) return;

  const filename = reviewFilename(doc.name);
  const handle = await pickSaveTarget(filename);
  if (handle === "cancelled") return;
  if (!handle) {
    downloadReview(output, filename);
    return;
  }

  try {
    const writable = await handle.createWritable();
    await writable.write(output);
    await writable.close();
    showToast("Рецензия сохранена.");
  } catch (error) {
    showToast(`Не удалось сохранить рецензию: ${error.message}`, "error");
  }
}

function openPreview() {
  elements.previewContent.textContent = getExportText();
  elements.previewDialog.showModal();
}

function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  const dark = state.theme === "dark";
  elements.themeToggle.title = dark ? "Светлая тема" : "Тёмная тема";
  elements.themeToggle.querySelector(".sr-only").textContent = dark
    ? "Включить светлую тему"
    : "Включить тёмную тему";
}

elements.openFiles.addEventListener("click", () => elements.fileInput.click());
elements.openFilesEmpty.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => loadFiles(elements.fileInput.files));
elements.documentSelect.addEventListener("change", () => activateDocument(elements.documentSelect.value));
elements.themeToggle.addEventListener("click", toggleTheme);
elements.copyReview.addEventListener("click", copyReview);
elements.saveReview.addEventListener("click", saveReview);
elements.previewReview.addEventListener("click", openPreview);
elements.closePreview.addEventListener("click", () => elements.previewDialog.close());
elements.previewDialog.addEventListener("click", (event) => {
  if (event.target === elements.previewDialog) elements.previewDialog.close();
});
elements.addGeneral.addEventListener("click", () => createFreeDraft());

elements.filterList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter-type]");
  if (!button) return;
  const type = button.dataset.filterType;
  if (state.selectedTypes.has(type)) state.selectedTypes.delete(type);
  else state.selectedTypes.add(type);
  renderFilters();
  renderReview();
});

elements.reviewList.addEventListener("input", (event) => {
  if (!state.draft) return;
  if (event.target.id === "draft-comment") state.draft.comment = event.target.value;
  if (event.target.id === "draft-replacement") state.draft.replacement = event.target.value;
});

elements.reviewList.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && state.draft) {
    event.preventDefault();
    commitDraft();
    return;
  }
  const card = event.target.closest(".review-card[data-entry-id]");
  if (card && event.target === card && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    activateEntry(card.dataset.entryId);
  }
});

elements.reviewList.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) {
    const card = event.target.closest(".review-card[data-entry-id]");
    if (card) activateEntry(card.dataset.entryId);
    return;
  }
  const id = action.dataset.entryId;
  if (action.dataset.action === "activate") activateEntry(id);
  if (action.dataset.action === "delete") deleteEntry(id);
  if (action.dataset.action === "add-general-after") {
    const entry = activeDocument()?.entries.find((item) => item.id === id);
    if (entry) createFreeDraft(entry);
  }
  if (action.dataset.action === "commit-draft") commitDraft();
  if (action.dataset.action === "cancel-draft") cancelDraft();
  if (action.dataset.action === "draft-type" && state.draft?.kind === "anchored") {
    syncDraftFields();
    state.draft.type = action.dataset.type;
    renderReview({ focusDraft: true });
  }
});

elements.documentBody.addEventListener("mouseup", () => requestAnimationFrame(handleSelection));
elements.documentBody.addEventListener("keydown", (event) => {
  const line = event.target.closest(".source-line.line-origin");
  if (!line) return;
  const origins = [...elements.documentBody.querySelectorAll(".source-line.line-origin")];
  const index = origins.indexOf(line);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    origins[Math.max(0, Math.min(origins.length - 1, index + delta))]?.focus();
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    showQuoteToolbar(wholeLineSelection(line), true);
  }
});

elements.quoteToolbar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-quote-type]");
  if (button) createAnchoredDraft(button.dataset.quoteType);
});
elements.documentPane.addEventListener("scroll", handleDocumentScroll, { passive: true });
window.addEventListener("resize", hideQuoteToolbar);

elements.searchInput.addEventListener("input", () => runSearch(elements.searchInput.value));
elements.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    navigateSearch(event.shiftKey ? -1 : 1);
  }
});
elements.searchPrev.addEventListener("click", () => navigateSearch(-1));
elements.searchNext.addEventListener("click", () => navigateSearch(1));

elements.tocList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-target]");
  if (!button) return;
  document.getElementById(button.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

updateHeader();
renderFilters();
renderReview();
renderDocument();
