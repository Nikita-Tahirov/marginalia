import {
  REVIEW_TYPES,
  anchoredSortKey,
  boundaryAfter,
  compareKeys,
  countByType,
  lineHeading,
  nextFreeOrder,
  normalizeEntry,
  orderReviewEntries,
  parseReview,
  pluralizeReview,
  serializeReview,
  sha256Hex,
  splitPhysicalLines,
} from "./core.js";
import { NBSP, planMarkdown, renderTokenRange } from "./markdown.js";
import {
  deleteDocument as forgetDocument,
  findByHash,
  listDocuments,
  loadReview,
  requestPersistence,
  storageIsPersistent,
  saveDocument,
  saveReview as storeReview,
} from "./storage.js";
import { setUpReadingScale } from "./reading.js";
import { keepAppFresh, noticeAfterUpdate } from "./updates.js";
import {
  canPromptInstall,
  dismissStorageNotice,
  isAppleMobile,
  isInstalled,
  persistDeclined,
  promptInstall,
  rememberPersistDecline,
  storageNoticeDismissed,
  watchInstallOffer,
} from "./install.js";
import "./panes.js";

const elements = {
  documentSelect: document.querySelector("#document-select"),
  openFiles: document.querySelector("#open-files"),
  openFilesEmpty: document.querySelector("#open-files-empty"),
  fileInput: document.querySelector("#file-input"),
  reviewInput: document.querySelector("#review-input"),
  openReview: document.querySelector("#open-review"),
  addVersion: document.querySelector("#add-version"),
  deleteDocument: document.querySelector("#delete-document"),
  storageNotice: document.querySelector("#storage-notice"),
  storageNoticeText: document.querySelector("#storage-notice-text"),
  installApp: document.querySelector("#install-app"),
  dismissStorageNotice: document.querySelector("#dismiss-storage-notice"),
  importNotice: document.querySelector("#import-notice"),
  saveState: document.querySelector("#save-state"),
  searchInput: document.querySelector("#search-input"),
  searchCounter: document.querySelector("#search-counter"),
  searchPrev: document.querySelector("#search-prev"),
  searchNext: document.querySelector("#search-next"),
  copyReview: document.querySelector("#copy-review"),
  saveReview: document.querySelector("#save-review"),
  themeToggle: document.querySelector("#theme-toggle"),
  textSmaller: document.querySelector("#text-smaller"),
  textLarger: document.querySelector("#text-larger"),
  tocList: document.querySelector("#toc-list"),
  documentMeta: document.querySelector("#document-meta"),
  documentLines: document.querySelector("#document-lines"),
  documentNotes: document.querySelector("#document-notes"),
  filterList: document.querySelector("#filter-list"),
  addGeneral: document.querySelector("#add-general"),
  reviewList: document.querySelector("#review-list"),
  previewReview: document.querySelector("#preview-review"),
  documentPane: document.querySelector("#document-pane"),
  documentEmpty: document.querySelector("#document-empty"),
  documentBody: document.querySelector("#document-body"),
  quoteToolbar: document.querySelector("#quote-toolbar"),
  rangeHandles: document.querySelector("#range-handles"),
  toast: document.querySelector("#toast"),
  previewDialog: document.querySelector("#preview-dialog"),
  previewContent: document.querySelector("#preview-content"),
  closePreview: document.querySelector("#close-preview"),
  pasteText: document.querySelector("#paste-text"),
  pasteDialog: document.querySelector("#paste-dialog"),
  pasteInput: document.querySelector("#paste-input"),
  submitPaste: document.querySelector("#submit-paste"),
  cancelPaste: document.querySelector("#cancel-paste"),
  closePaste: document.querySelector("#close-paste"),
  renameDocument: document.querySelector("#rename-document"),
  renameDialog: document.querySelector("#rename-dialog"),
  renameInput: document.querySelector("#rename-input"),
  submitRename: document.querySelector("#submit-rename"),
  cancelRename: document.querySelector("#cancel-rename"),
  closeRename: document.querySelector("#close-rename"),
};

const state = {
  documents: [],
  activeDocumentId: null,
  selectedTypes: new Set(REVIEW_TYPES),
  draft: null,
  // Открытая правка уже добавленной записи: копия её изменяемых полей. Правим
  // копию, а не саму запись, чтобы «Отмена» возвращала прежний текст, а не то,
  // что человек успел набрать и передумал.
  edit: null,
  pendingSelection: null,
  // Строка, с которой панель цитаты открыта с клавиатуры: ей возвращаем фокус.
  quoteOrigin: null,
  activeEntryId: null,
  searchResults: [],
  searchIndex: -1,
  toastTimer: null,
  theme: "light",
  // Куда попадёт следующий выбранный файл: null — новый документ, иначе новая
  // версия названной семьи. Семью выбирает пользователь кнопкой, а не догадка
  // по имени файла: «статья_v2.md» и «статья_финал.md» для эвристики неразличимы.
  versionTarget: null,
  persistenceRequested: false,
  persistent: false,
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
  return serializeReview(doc?.entries ?? [], doc ?? null);
}

function updateHeader() {
  const doc = activeDocument();
  elements.documentSelect.disabled = !state.documents.length;
  elements.searchInput.disabled = !doc;
  elements.addGeneral.disabled = !doc;
  elements.openReview.disabled = !doc;
  elements.addVersion.disabled = !doc;
  elements.renameDocument.disabled = !doc;
  elements.deleteDocument.disabled = !doc;

  elements.documentSelect.replaceChildren();
  if (!state.documents.length) {
    elements.documentSelect.append(new Option("Документ не открыт", ""));
  } else {
    for (const item of state.documents) {
      // Номер версии показываем только там, где версий больше одной: для
      // единственного документа он был бы шумом. Длину документа называет
      // соседний #document-meta — в списке она повторялась бы у каждой строки.
      const version = familySize(item.familyId) > 1 ? ` · вер. ${item.version}` : "";
      const option = new Option(`${item.name}${version}`, item.id);
      option.selected = item.id === state.activeDocumentId;
      elements.documentSelect.append(option);
    }
    // Длинное имя всё равно упрётся в ширину поля: подсказка показывает его
    // целиком, не заставляя раскрывать список ради одного взгляда.
    elements.documentSelect.title = doc ? doc.name : "";
  }

  const count = doc?.entries.length ?? 0;
  elements.copyReview.disabled = !doc || count === 0;
  elements.saveReview.disabled = !doc || count === 0;
  elements.previewReview.disabled = !doc || count === 0;

  // Замечаний столько, сколько их записано: черновик, который человек сейчас
  // печатает, ещё ничего не значит и в счёт не идёт.
  setMetaChip(
    elements.documentNotes,
    doc ? count : null,
    plural(count, "замечание", "замечания", "замечаний"),
  );
}

// Число и подпись — разные узлы: на узкой шапке подпись убирается стилями, и
// тогда полностью её называет подсказка.
function setMetaChip(chip, count, word) {
  if (count === null) {
    chip.replaceChildren();
    chip.removeAttribute("data-tooltip");
    return;
  }
  const value = document.createElement("span");
  value.textContent = String(count);
  const label = document.createElement("span");
  label.className = "meta-word";
  // Пробел живёт внутри скрываемого узла: убрали подпись — исчез и он, а текст
  // счётчика остаётся читаемым для проверок и для чтения с экрана.
  label.textContent = ` ${word}`;
  chip.replaceChildren(value, label);
  chip.dataset.tooltip = `${count} ${word}`;
}

// Русское число согласуется со словом, и «1 строк» в шапке читается как
// недоделка. Разбор один на оба счётчика: их два и оба на виду.
function plural(count, one, few, many) {
  const tens = count % 100;
  if (tens > 10 && tens < 20) return many;
  const units = count % 10;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
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
  return `type-${String(type).toLowerCase()}`;
}

// Карточка собирается строкой ради скорости на длинной рецензии, поэтому ¬одно
// поле не попадает в разметку без экранирования — включая те, что по замыслу
// содержат число или значение из известного набора. Форму записи проверяет
// normalizeEntry; это второй рубеж на случай, если она когда-нибудь пропустит.
// Текст карточки — не витрина, а поле, в которое ещё вернутся: по нему кликают
// и правят. Поэтому пустой комментарий не исчезает, а остаётся приглашением —
// иначе к записи, начатой одним типом, нечем было бы вернуться.
function anchoredCard(entry) {
  const written = entry.replacement?.trim();
  // Замена — единственное поле карточки, которое можно осмысленно оставить
  // пустым: замечание бывает и без готовой редакции. Раньше «Правка» и
  // «Переписать» показывали пустую рамку приглашением, но в узкой колонке она
  // занимает место, ничего не сообщая. Дописать замену по-прежнему можно
  // карандашом: редактор открывает поле независимо от того, пусто ли оно.
  const replacement = written
    ? `<div class="replacement" data-action="edit-field" data-field="replacement" data-entry-id="${escapeHtml(entry.id)}" role="button" tabindex="0"><span>Заменить на</span><p>${renderMultiline(written)}</p></div>`
    : "";
  const active = entry.id === state.activeEntryId ? " is-active" : "";
  const id = escapeHtml(entry.id);
  return `<article class="review-card ${escapeHtml(typeClass(entry.type))}${active}" data-entry-id="${id}" tabindex="0">
    <header class="card-header">
      <span class="type-badge">${escapeHtml(entry.type)}</span>
      <button class="line-link" type="button" data-action="activate" data-entry-id="${id}">${escapeHtml(lineHeading(entry).toLowerCase())}</button>
      <button class="card-edit" type="button" data-action="edit" data-entry-id="${id}" aria-label="Изменить замечание"><span class="mi" aria-hidden="true">edit</span></button>
      <button class="card-delete" type="button" data-action="delete" data-entry-id="${id}" aria-label="Удалить замечание">×</button>
    </header>
    <blockquote>${renderMultiline(entry.quote)}</blockquote>
    ${commentBlock(entry)}
    ${replacement}
  </article>`;
}

// Место вставки живёт между карточками, а не внутри них: добавляют не «к
// этому замечанию», а в промежуток после него, и подпись «+ Общее после» в
// каждой карточке отнимала строку у самого замечания. Разметка нулевой высоты
// — колонку раздвигает только зазор списка, а не спрятанная кнопка.
function insertPoint(entry) {
  const id = escapeHtml(entry.id);
  // Плюс нарисован здесь, а не взят из шрифта иконок: тот урезан до девяти
  // глифов, которые уже нужны интерфейсу, и ради одной черты его пришлось бы
  // запрашивать заново снаружи.
  return `<div class="card-insert"><button type="button" class="insert-note" data-action="add-general-after" data-entry-id="${id}" data-tooltip="Добавить замечание" aria-label="Добавить замечание"><svg class="glyph" aria-hidden="true" width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 3v7M3 6.5h7"></path></svg></button></div>`;
}

function commentBlock(entry) {
  const written = entry.comment.trim();
  return `<p class="card-comment${written ? "" : " is-empty"}" data-action="edit-field" data-field="comment" data-entry-id="${escapeHtml(entry.id)}" role="button" tabindex="0">${written ? renderMultiline(written) : "Комментарий"}</p>`;
}

function freeCard(entry) {
  const id = escapeHtml(entry.id);
  return `<article class="review-card free-card" data-entry-id="${id}" tabindex="0">
    <header class="card-header">
      <span class="general-badge">Общее замечание</span>
      <span class="free-position">без строки</span>
      <button class="card-edit" type="button" data-action="edit" data-entry-id="${id}" aria-label="Изменить общее замечание"><span class="mi" aria-hidden="true">edit</span></button>
      <button class="card-delete" type="button" data-action="delete" data-entry-id="${id}" aria-label="Удалить общее замечание">×</button>
    </header>
    ${commentBlock(entry)}
  </article>`;
}

function typeChoices(activeType, action = "draft-type") {
  return REVIEW_TYPES.map(
    (type) => `<button
      class="draft-type ${typeClass(type)}${type === activeType ? " is-active" : ""}"
      type="button"
      data-action="${action}"
      data-type="${type}"
      aria-pressed="${type === activeType}"
    >${type}</button>`,
  ).join("");
}

// Замечание пишут от руки и по-русски, а перечитывают его уже в чужом файле:
// подчёркнутая браузером опечатка — единственный шанс заметить её до выгрузки.
// Язык объявлен на самом поле, а не унаследован от документа: словарь браузер
// выбирает по ближайшему lang, и вставка статьи на другом языке выше по дереву
// не должна уводить проверку замечаний на чужой словарь. Текст статьи и имя
// файла этим не покрыты намеренно — их не пишут, а получают готовыми.
const NOTE_FIELD = ' spellcheck="true" lang="ru"';

function draftCard(entry) {
  const anchored = entry.kind === "anchored";
  // Привязанное замечание осмысленно и без слов: тип и процитированные строки
  // уже высказывание. Общее замечание, наоборот, состоит из одного текста —
  // пустое оно ничего не значит, поэтому там поле остаётся обязательным.
  const ready = anchored || Boolean(entry.comment.trim());
  return `<article class="review-card draft-card" data-entry-id="${escapeHtml(entry.id)}">
    <header class="draft-heading">
      <span>Новое ${anchored ? "замечание" : "общее замечание"}</span>
      <span>${anchored ? escapeHtml(lineHeading(entry).toLowerCase()) : "без строки"}</span>
    </header>
    ${anchored ? `<blockquote>${renderMultiline(entry.quote)}</blockquote><div class="draft-types" role="group" aria-label="Тип замечания">${typeChoices(entry.type)}</div>` : ""}
    <label class="draft-label" for="draft-comment">${anchored ? "Комментарий" : `Текст общего замечания <span aria-hidden="true">*</span>`}</label>
    <textarea id="draft-comment" class="input draft-textarea" rows="4"${anchored ? "" : " required"}${NOTE_FIELD}>${escapeHtml(entry.comment)}</textarea>
    ${anchored ? `<label class="draft-label" for="draft-replacement">Заменить на</label><textarea id="draft-replacement" class="input draft-textarea replacement-input" rows="3"${NOTE_FIELD}>${escapeHtml(entry.replacement)}</textarea>` : ""}
    <div class="draft-actions">
      <button class="btn btn-primary compact-btn" type="button" data-action="commit-draft"${ready ? "" : " disabled"}>Добавить</button>
      <button class="btn btn-ghost compact-btn" type="button" data-action="cancel-draft">Отмена</button>
      <span>⌘/Ctrl+Enter</span>
    </div>
  </article>`;
}

// Форма правки повторяет форму черновика: человек уже знает, где что лежит, и
// второе устройство тех же полей было бы лишним знанием. Цитата и строки в неё
// не входят — они якорь записи, а не её содержание; чтобы указать на другое
// место, его выделяют заново.
function editCard(entry) {
  const edit = state.edit;
  const anchored = entry.kind === "anchored";
  return `<article class="review-card draft-card edit-card ${escapeHtml(typeClass(edit.type))}" data-entry-id="${escapeHtml(entry.id)}">
    <header class="draft-heading">
      <span>${anchored ? "Замечание" : "Общее замечание"}</span>
      <span>${anchored ? escapeHtml(lineHeading(entry).toLowerCase()) : "без строки"}</span>
    </header>
    ${anchored ? `<blockquote>${renderMultiline(entry.quote)}</blockquote><div class="draft-types" role="group" aria-label="Тип замечания">${typeChoices(edit.type, "edit-type")}</div>` : ""}
    <label class="draft-label" for="edit-comment">${anchored ? "Комментарий" : `Текст общего замечания <span aria-hidden="true">*</span>`}</label>
    <textarea id="edit-comment" class="input draft-textarea" rows="4"${anchored ? "" : " required"}${NOTE_FIELD}>${escapeHtml(edit.comment)}</textarea>
    ${anchored ? `<label class="draft-label" for="edit-replacement">Заменить на</label><textarea id="edit-replacement" class="input draft-textarea replacement-input" rows="3"${NOTE_FIELD}>${escapeHtml(edit.replacement)}</textarea>` : ""}
    <div class="draft-actions draft-hint">
      <span>Сохраняется само</span>
      <span>Esc или ⌘/Ctrl+Enter — закончить</span>
    </div>
  </article>`;
}

function renderReview({ focus = null } = {}) {
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
      // Незавершённая запись — черновик и открытая форма правки — ещё не
      // граница: вставлять после неё нечего, пока она не стала замечанием.
      if (entry.status === "draft") return draftCard(entry);
      if (entry.id === state.edit?.id) return editCard(entry);
      const card = entry.kind === "anchored" ? anchoredCard(entry) : freeCard(entry);
      return card + insertPoint(entry);
    })
    .join("");

  if (focus) {
    requestAnimationFrame(() => {
      const field = elements.reviewList.querySelector(focus);
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

// Уступка главному потоку между порциями. scheduler.yield возвращает работу
// быстрее обычной отложенной задачи, но его нет в Safari, поэтому запасной путь
// обязателен, а не желателен.
function yieldToMainThread() {
  if (typeof scheduler !== "undefined" && typeof scheduler?.yield === "function") {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Сколько миллисекунд подряд позволено занимать главный поток. Задача длиннее
// пятидесяти миллисекунд уже считается длинной, а на слабом планшете каждая
// такая порция растягивается в несколько раз, поэтому запас взят с избытком.
const CHUNK_BUDGET_MS = 12;

// Верхняя граница на размер группы. Одного лишь запаса по времени мало: на
// быстрой машине в порцию попадает весь документ, группа выходит огромной, и
// смысл пропуска раскладки теряется — вместе с предсказуемостью проверок.
const CHUNK_BLOCK_LIMIT = 40;

// Номер отрисовки: человек может переключить статью, пока предыдущая ещё
// собирается, и незаконченная сборка не должна досыпать свои блоки в чужой
// документ.
let renderGeneration = 0;

// Указатель строк: по номеру физической строки — её куски в документе и их
// текст. Собирается заодно со сборкой, по готовому фрагменту до вставки, когда
// раскладка ещё не нужна. Без него каждое замечание и каждая буква в поиске
// стоили бы обхода всех четырнадцати тысяч кусков.
let lineIndex = new Map();

// Неразрывный пробел ставит типографика при показе — его нет ни в статье, ни в
// том, что человек набирает. Поэтому из экрана он не должен уходить дальше
// экрана: в цитате он уехал бы в файл рецензии, а в поиске запрос с обычным
// пробелом перестал бы находить строку, которая на вид ему точно отвечает.
// Длина от замены не меняется, поэтому колонки цитаты и смещения совпадений
// остаются верными.
function asTyped(text) {
  return text.replaceAll(NBSP, " ");
}

function indexFragment(fragment) {
  for (const span of fragment.querySelectorAll(".source-line")) {
    const line = Number(span.dataset.sourceLine);
    const known = lineIndex.get(line);
    if (known) {
      known.spans.push(span);
      known.text += asTyped(span.textContent);
    } else {
      lineIndex.set(line, { spans: [span], text: asTyped(span.textContent) });
    }
  }
}

function indexedLine(line) {
  return lineIndex.get(line) ?? null;
}

async function fillDocument(text, generation) {
  const plan = planMarkdown(text);
  let index = 0;

  while (index < plan.ranges.length) {
    const started = performance.now();
    const batch = document.createDocumentFragment();
    let blocks = 0;
    while (
      index < plan.ranges.length &&
      blocks < CHUNK_BLOCK_LIMIT &&
      performance.now() - started < CHUNK_BUDGET_MS
    ) {
      batch.append(renderTokenRange(plan, plan.ranges[index]));
      index += 1;
      blocks += 1;
    }
    if (generation !== renderGeneration) return false;
    indexFragment(batch);
    const group = document.createElement("div");
    group.className = "document-chunk";
    group.append(batch);
    elements.documentBody.append(group);
    if (index < plan.ranges.length) await yieldToMainThread();
    if (generation !== renderGeneration) return false;
  }

  return true;
}

function renderDocument() {
  const doc = activeDocument();
  const generation = (renderGeneration += 1);
  hideQuoteToolbar();
  hideRangeHandles();
  elements.documentBody.replaceChildren();
  lineIndex = new Map();
  markedLines = new Map();
  activeLines = new Set();
  highlightedLines = new Set();
  // Диапазоны прошлой сборки держат уже выброшенные узлы — снимаем их сразу,
  // не дожидаясь, пока документ соберётся заново.
  clearFragmentHighlights();
  state.searchResults = [];
  state.searchIndex = -1;
  elements.searchInput.value = "";
  updateSearchCounter();

  if (!doc) {
    elements.documentBody.hidden = true;
    elements.documentEmpty.hidden = false;
    elements.documentBody.dataset.rendered = "complete";
    elements.tocList.innerHTML = `<span class="toc-empty">Откройте документ</span>`;
    setMetaChip(elements.documentLines, null);
    return;
  }

  elements.documentEmpty.hidden = true;
  elements.documentBody.hidden = false;
  const lines = doc.lineData.lines.length;
  setMetaChip(elements.documentLines, lines, plural(lines, "строка", "строки", "строк"));

  if (doc.text.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rendered-empty";
    empty.textContent = "Документ пуст.";
    elements.documentBody.append(empty);
    elements.documentBody.dataset.rendered = "complete";
    renderToc();
    applyAnnotationMarkers();
    return;
  }

  elements.documentBody.dataset.rendered = "partial";
  fillDocument(doc.text, generation).then((finished) => {
    if (!finished) return;
    elements.documentBody.dataset.rendered = "complete";
    renderToc();
    applyAnnotationMarkers();
  });
}

// Какие строки сейчас размечены и какая из них выделена. Помним это, чтобы
// снимать пометки ровно там, где они стояли: обходить весь документ ради
// одного добавленного замечания незачем.
let markedLines = new Map();
let activeLines = new Set();

// Замечание к части строки рисуется по самой цитате, а не по строке целиком.
// Абзац в Markdown — одна физическая строка, поэтому пометка всей строки в
// статье без жёстких переносов подсвечивает целый абзац там, где процитировано
// одно предложение. Границы цитаты запись хранила с самого начала
// (startColumn/endColumn) — здесь они доходят до разметки.
//
// Рисуется через ::highlight: обёртка фрагмента в элемент разрезала бы
// текстовые узлы документа, а по ним считают и поиск, и указатель строк, и
// колонки следующего выделения. Где этого API нет, замечание помечает строку
// целиком — ровно как раньше.
// Цвет цитаты называет тип замечания, а псевдоэлемент подсветки красит весь
// свой набор разом — значит наборов столько, сколько типов, и вдвое больше:
// открытая запись рисуется поверх остальных.
const HIGHLIGHT_SLUGS = {
  Правка: "edit",
  Вопрос: "question",
  Удалить: "delete",
  Переписать: "rewrite",
};

function highlightName(type, active) {
  return `marginalia-${active ? "active" : "note"}-${HIGHLIGHT_SLUGS[type] ?? HIGHLIGHT_SLUGS[REVIEW_TYPES[0]]}`;
}

const HIGHLIGHT_NAMES = REVIEW_TYPES.flatMap((type) => [
  highlightName(type, false),
  highlightName(type, true),
]);

const fragmentHighlightsSupported =
  typeof Highlight === "function" && typeof CSS !== "undefined" && Boolean(CSS.highlights);

function textPoint(span, offset) {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let rest = offset;
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (rest <= node.length) return { node, offset: rest };
    rest -= node.length;
    last = node;
  }
  return last ? { node: last, offset: last.length } : { node: span, offset: 0 };
}

// Колонка отсчитывается по всей логической строке, а строка может быть разрезана
// мягким переносом на несколько кусков — идём по ним, пока колонка не попадёт
// внутрь очередного.
function linePoint(line, column) {
  const spans = lineGroup(line);
  if (!spans.length) return null;
  let rest = Math.max(0, column);
  for (const span of spans) {
    const length = span.textContent.length;
    if (rest <= length) return textPoint(span, rest);
    rest -= length;
  }
  const last = spans.at(-1);
  return textPoint(last, last.textContent.length);
}

function coversWholeLines(entry) {
  if (entry.startColumn > 0) return false;
  const end = indexedLine(entry.endLine);
  return Boolean(end) && entry.endColumn >= end.text.length;
}

function sameText(left, right) {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

// Диапазон записи в собранном документе. Пустой ответ означает, что показать
// точное место нельзя: строки ещё не отрисованы либо колонки не сходятся с
// сохранённой цитатой. Последнее — обычное дело для рецензии к другой версии
// статьи и для файла, разобранного по тексту: колонок в нём не было. Взяться за
// такие границы нельзя ни подсветкой, ни меткой — они уверенно показали бы не
// то место.
function anchorRange(entry) {
  const start = linePoint(entry.startLine, entry.startColumn);
  const end = linePoint(entry.endLine, entry.endColumn);
  if (!start || !end) return null;

  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  if (range.collapsed) return null;
  return sameText(range.toString(), entry.quote) ? range : null;
}

// Замечание, занимающее строки целиком, помечается самой строкой: заливка
// цитаты повторила бы её край в край, ничего не добавив.
function fragmentRange(entry) {
  return coversWholeLines(entry) ? null : anchorRange(entry);
}

function publishHighlight(name, highlight) {
  if (!fragmentHighlightsSupported) return;
  if (highlight.size) CSS.highlights.set(name, highlight);
  else CSS.highlights.delete(name);
}

function clearFragmentHighlights() {
  if (!fragmentHighlightsSupported) return;
  for (const name of HIGHLIGHT_NAMES) CSS.highlights.delete(name);
}

function applyAnnotationMarkers() {
  const doc = activeDocument();
  const active = doc?.entries.find((entry) => entry.id === state.activeEntryId);

  const counts = new Map();
  const nextActive = new Set();
  const fragments = fragmentHighlightsSupported
    ? new Map(HIGHLIGHT_NAMES.map((name) => [name, new Highlight()]))
    : null;

  for (const entry of doc?.entries ?? []) {
    if (entry.kind !== "anchored") continue;

    const fragment = fragments ? fragmentRange(entry) : null;
    if (fragment) {
      fragments.get(highlightName(entry.type, entry === active)).add(fragment);
      continue;
    }

    for (let line = entry.startLine; line <= entry.endLine; line += 1) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
      if (entry === active) nextActive.add(line);
    }
  }

  for (const [line] of markedLines) {
    if (counts.has(line)) continue;
    for (const span of indexedLine(line)?.spans ?? []) {
      span.classList.remove("is-annotated");
      span.removeAttribute("data-annotation-count");
    }
  }

  for (const [line, count] of counts) {
    if (markedLines.get(line) === count) continue;
    for (const span of indexedLine(line)?.spans ?? []) {
      span.classList.add("is-annotated");
      span.dataset.annotationCount = String(count);
    }
  }

  markedLines = counts;

  for (const line of activeLines) {
    if (nextActive.has(line)) continue;
    for (const span of indexedLine(line)?.spans ?? []) span.classList.remove("is-active-annotation");
  }
  for (const line of nextActive) {
    if (activeLines.has(line)) continue;
    for (const span of indexedLine(line)?.spans ?? []) span.classList.add("is-active-annotation");
  }

  activeLines = nextActive;

  scheduleHandleUpdate();

  if (!fragments) return;
  for (const [name, highlight] of fragments) {
    // Выделенное замечание рисуется поверх остальных: на пересечении двух цитат
    // должен побеждать тот стиль, который человек сейчас и открыл.
    if (name.startsWith("marginalia-active-")) highlight.priority = 1;
    publishHighlight(name, highlight);
  }
}

// Границы замечания. Цитата подсвечена ::highlight, а у подсветки нет ни узлов,
// ни краёв, за которые можно взяться, — поэтому границы обозначены двумя
// метками, которые ставятся по координатам диапазона.
//
// Метки показываются у одного замечания — того, что сейчас разобрано. Это не
// экономия, а условие отклика: координаты берутся из раскладки, и читать их для
// всей рецензии на статье в двадцать тысяч строк значит вернуть ту самую
// заморозку, ради которой из документа убрали замеры отступов.
const handles = {
  start: elements.rangeHandles.querySelector('[data-edge="start"]'),
  end: elements.rangeHandles.querySelector('[data-edge="end"]'),
};

function activeAnchoredEntry() {
  const entry = activeDocument()?.entries.find((item) => item.id === state.activeEntryId);
  return entry?.kind === "anchored" ? entry : null;
}

function hideRangeHandles() {
  elements.rangeHandles.hidden = true;
}

function placeHandle(handle, left, top, height) {
  handle.style.left = `${left}px`;
  handle.style.top = `${top}px`;
  handle.style.height = `${height}px`;
}

function updateRangeHandles() {
  const entry = activeAnchoredEntry();
  const range = entry ? anchorRange(entry) : null;
  // Диапазон занимает столько прямоугольников, на сколько экранных строк лёг:
  // начало живёт в первом, конец — в последнем.
  const rects = range ? [...range.getClientRects()].filter((rect) => rect.width || rect.height) : [];
  if (!rects.length) {
    hideRangeHandles();
    return;
  }

  const paneRect = elements.documentPane.getBoundingClientRect();
  const offsetX = elements.documentPane.scrollLeft - paneRect.left;
  const offsetY = elements.documentPane.scrollTop - paneRect.top;
  const first = rects[0];
  const last = rects.at(-1);
  placeHandle(handles.start, first.left + offsetX, first.top + offsetY, first.height);
  placeHandle(handles.end, last.right + offsetX, last.top + offsetY, last.height);
  elements.rangeHandles.hidden = false;
}

// Пересчёт идёт кадром: прокрутка, перетаскивание границы и изменение ширины
// панелей приходят чаще, чем браузер успевает рисовать, а координаты нужны один
// раз на кадр.
let handleFrame = 0;

function scheduleHandleUpdate() {
  if (handleFrame) return;
  handleFrame = requestAnimationFrame(() => {
    handleFrame = 0;
    updateRangeHandles();
  });
}

// Место в тексте под указателем. caretPositionFromPoint — стандарт, но в WebKit
// он появился недавно, и запасной путь здесь обязателен, а не желателен.
function caretAt(x, y) {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (typeof document.caretRangeFromPoint === "function") {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

function locationAt(x, y) {
  const caret = caretAt(x, y);
  const span = caret && sourceSpan(caret.node);
  if (!span || !elements.documentBody.contains(span)) return null;
  return {
    line: Number(span.dataset.sourceLine),
    column: cumulativeLineOffset(span, offsetInside(span, caret.node, caret.offset)),
  };
}

// Шаг клавишей — один символ, а строка кончается там, где кончается её текст:
// за краем берём соседнюю отрисованную строку. Идём по указателю строк, а не по
// счёту: пустые строки разметки в нём не значатся, и шаг через них попал бы в
// строку, которой на экране нет.
function shiftLocation({ line, column }, direction) {
  const known = indexedLine(line);
  if (!known) return null;
  const shifted = column + direction;
  if (shifted >= 0 && shifted <= known.text.length) return { line, column: shifted };
  const numbers = [...lineIndex.keys()];
  const neighbour = numbers[numbers.indexOf(line) + direction];
  if (neighbour === undefined) return null;
  return { line: neighbour, column: direction > 0 ? 0 : (indexedLine(neighbour)?.text.length ?? 0) };
}

// Переставляет край записи и пересобирает цитату по новому месту. Цитата берётся
// из самого документа, а не правится строкой: что видно на экране, то и уедет в
// файл рецензии, поэтому она проходит asTyped — иначе неразрывные пробелы показа
// оказались бы в выгрузке и перестали находиться поиском.
function moveAnchor(entry, edge, location) {
  const bounds = {
    startLine: entry.startLine,
    startColumn: entry.startColumn,
    endLine: entry.endLine,
    endColumn: entry.endColumn,
  };
  if (edge === "start") {
    bounds.startLine = location.line;
    bounds.startColumn = location.column;
  } else {
    bounds.endLine = location.line;
    bounds.endColumn = location.column;
  }
  // Края не меняются местами и не сходятся в точку: замечание без единого
  // символа не значит ничего, а перевёрнутое молча указало бы не туда.
  if (compareKeys([bounds.startLine, bounds.startColumn], [bounds.endLine, bounds.endColumn]) >= 0) {
    return false;
  }

  const start = linePoint(bounds.startLine, bounds.startColumn);
  const end = linePoint(bounds.endLine, bounds.endColumn);
  if (!start || !end) return false;
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return false;
  }
  const quote = asTyped(range.toString());
  if (!quote.trim()) return false;

  Object.assign(entry, bounds, { quote });
  return true;
}

// Пока границу двигают, список не перестраивается: карточка ушла бы из-под
// курсора, а собирать всю рецензию заново на каждое движение мыши дороже самого
// перетаскивания. Меняем на месте ровно то, что зависит от границ.
function fillMultiline(node, value) {
  const parts = String(value).split("\n");
  node.replaceChildren(
    ...parts.flatMap((part, index) => (index ? [document.createElement("br"), part] : [part])),
  );
}

function refreshAnchorCard(entry) {
  const card = elements.reviewList.querySelector(
    `.review-card[data-entry-id="${CSS.escape(entry.id)}"]`,
  );
  if (!card) return;
  const quote = card.querySelector("blockquote");
  if (quote) fillMultiline(quote, entry.quote);
  const heading = card.querySelector(".line-link") ?? card.querySelector(".draft-heading span:last-child");
  if (heading) heading.textContent = lineHeading(entry).toLowerCase();
}

function applyAnchorMove(entry, edge, location) {
  if (!moveAnchor(entry, edge, location)) return false;
  refreshAnchorCard(entry);
  applyAnnotationMarkers();
  return true;
}

// Порядок записей задаётся началом цитаты, поэтому сдвинутая граница может
// перевести карточку через соседнюю: по окончании список пересобирается целиком.
let anchorSaveTimer = 0;

function finishAnchorChange() {
  clearTimeout(anchorSaveTimer);
  anchorSaveTimer = 0;
  const doc = activeDocument();
  if (!doc) return;
  refreshReviewState();
  persistReview(doc, { failed: "Область замечания изменена, но не сохранена." });
}

function scheduleAnchorFinish() {
  clearTimeout(anchorSaveTimer);
  anchorSaveTimer = setTimeout(finishAnchorChange, 500);
}

let dragging = null;

// Слушаем не саму метку с захватом указателя, а документ: метка едет за
// курсором и оказывается ровно под ним, а место в тексте определяется
// попаданием точки — под собственной меткой оно вернуло бы кнопку вместо буквы.
// Поэтому на время протяжки метки перестают ловить попадания (data-dragging в
// стилях), и события приходят обычным всплытием.
function startHandleDrag(handle, event) {
  const entry = activeAnchoredEntry();
  if (!entry) return;
  // Без этого браузер начнёт выделять текст под меткой, и протяжка обернётся
  // новым выделением поверх того замечания, которое человек правит.
  event.preventDefault();
  dragging = { edge: handle.dataset.edge, moved: false };
  elements.rangeHandles.dataset.dragging = "";
  document.body.dataset.anchoring = "";
  handle.focus({ preventScroll: true });
  document.addEventListener("pointermove", dragHandleTo);
  document.addEventListener("pointerup", stopHandleDrag);
  document.addEventListener("pointercancel", stopHandleDrag);
}

function dragHandleTo(event) {
  if (!dragging) return;
  const entry = activeAnchoredEntry();
  const location = entry && locationAt(event.clientX, event.clientY);
  if (!location) return;
  const current =
    dragging.edge === "start"
      ? { line: entry.startLine, column: entry.startColumn }
      : { line: entry.endLine, column: entry.endColumn };
  // Указатель ходит чаще, чем меняется буква под ним: пересборка цитаты и
  // подсветки нужна только там, где граница действительно переехала.
  if (location.line === current.line && location.column === current.column) return;
  if (applyAnchorMove(entry, dragging.edge, location)) dragging.moved = true;
}

function stopHandleDrag() {
  if (!dragging) return;
  document.removeEventListener("pointermove", dragHandleTo);
  document.removeEventListener("pointerup", stopHandleDrag);
  document.removeEventListener("pointercancel", stopHandleDrag);
  delete elements.rangeHandles.dataset.dragging;
  delete document.body.dataset.anchoring;
  const moved = dragging.moved;
  dragging = null;
  if (moved) finishAnchorChange();
}

function nudgeAnchor(handle, event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const entry = activeAnchoredEntry();
  if (!entry) return;
  event.preventDefault();
  const edge = handle.dataset.edge;
  const from =
    edge === "start"
      ? { line: entry.startLine, column: entry.startColumn }
      : { line: entry.endLine, column: entry.endColumn };
  const next = shiftLocation(from, event.key === "ArrowRight" ? 1 : -1);
  if (!next || !applyAnchorMove(entry, edge, next)) return;
  // Клавишу держат сериями: список и запись обновляем в паузе, иначе каждое
  // нажатие перестраивало бы рецензию и писало в хранилище.
  scheduleAnchorFinish();
}

for (const handle of Object.values(handles)) {
  handle.addEventListener("pointerdown", (event) => startHandleDrag(handle, event));
  // Выделение текста начинается с mousedown, и отказ на pointerdown его не
  // отменяет: без этого протяжка по тексту оставляла бы за собой выделение.
  handle.addEventListener("mousedown", (event) => event.preventDefault());
  handle.addEventListener("keydown", (event) => nudgeAnchor(handle, event));
  // Уходя с метки, человек заканчивает правку: ждать паузы таймера незачем.
  handle.addEventListener("blur", () => {
    if (anchorSaveTimer) finishAnchorChange();
  });
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
  state.edit = null;
  state.pendingSelection = null;
  state.activeEntryId = null;
  state.selectedTypes = new Set(REVIEW_TYPES);
  applyImportNotice(null);
  updateHeader();
  renderFilters();
  renderReview();
  renderDocument();
}

// В хранилище едет только то, что нельзя вычислить: lineData целиком выводится
// из текста и восстанавливается при чтении.
function storedShape(doc) {
  return {
    id: doc.id,
    name: doc.name,
    text: doc.text,
    sha256: doc.sha256,
    familyId: doc.familyId,
    version: doc.version,
    createdAt: doc.createdAt,
  };
}

// Опознаватель записи попадает в разметку карточки, поэтому из хранилища
// принимается только то, что приложение само и выдавало.
const ENTRY_ID = /^[0-9a-f-]{36}$/;

// Хранилище — не доверенный источник: в него уже могла лечь запись из чужого
// файла, разобранного прежней версией приложения. Записи пересобираются по той
// же форме при каждом чтении, иначе исправление обошло бы как раз тех, у кого
// такая запись сохранена.
function restoreDocument(stored, review) {
  const entries = (review?.entries ?? [])
    .map((entry, index) => {
      const normalized = normalizeEntry(entry, index);
      if (!normalized) return null;
      const id = typeof entry?.id === "string" && ENTRY_ID.test(entry.id) ? entry.id : crypto.randomUUID();
      return { ...normalized, id };
    })
    .filter(Boolean);
  return {
    ...stored,
    lineData: splitPhysicalLines(stored.text),
    entries,
    sequence: review?.sequence ?? 0,
  };
}

async function persistDocument(doc) {
  await saveDocument(storedShape(doc));
}

// Об удачной записи говорит то же сообщение, что и о самом действии, поэтому в
// шапке остаётся только несохранённая работа: два разных угла экрана заставляли
// человека следить за обоими, а сообщение о возможной потере гаснуть не должно.
function showSaveState(state) {
  const failed = state === "failed";
  elements.saveState.hidden = !failed;
  elements.saveState.dataset.state = state;
  elements.saveState.textContent = failed ? "Не сохранено" : "";
}

// Действие и его запись для человека — одно событие, поэтому и сообщение одно:
// «Замечание сохранено», а не «добавлено» отдельно от «сохранено».
// Возвращает, легла ли работа в хранилище: вызывающей стороне бывает нужно
// сказать об исходе своими словами, а не сообщением, которое тут же затрут.
async function persistReview(doc, notice = null) {
  if (!doc) return false;
  const written = await storeReview(doc.id, doc.entries, doc.sequence);
  const saved = written !== null;
  showSaveState(saved ? "saved" : "failed");
  // Об удачной записи говорят не всегда: замечание, созданное выделением,
  // человек в этот момент ещё пишет, и сообщение поверх формы было бы помехой.
  // О потере данных молчать нельзя никогда.
  const message = saved ? notice?.saved : notice?.failed;
  if (message) showToast(message, saved ? "info" : "error");
  // Устойчивость просим в момент, когда появились данные, которые больно
  // потерять: на пустом приложении запрос выглядел бы беспричинным. Браузер
  // отказывает свежему сайту без истории посещений, поэтому попытку повторяем
  // в каждом сеансе, пока режим не выдан, — а не один раз навсегда. Firefox
  // спрашивает человека диалогом: его отказ запоминаем и не переспрашиваем.
  if (!state.persistenceRequested && doc.entries.length && !persistDeclined()) {
    state.persistenceRequested = true;
    state.persistent = await requestPersistence();
    if (!state.persistent) rememberPersistDecline();
    showStorageNotice();
  }

  return saved;
}

// Человек должен знать, где лежит его работа, — но узнавать это не постфактум
// и не из пустого экрана. Пока рецензии нет, говорить не о чем; как только она
// появилась, а браузер устойчивость не дал, показываем положение дел и
// единственное действие, которое его меняет.
function showStorageNotice() {
  const hasReview = state.documents.some((doc) => doc.entries.length);
  const secure = state.persistent || isInstalled();
  elements.storageNotice.hidden = !hasReview || secure || storageNoticeDismissed();
  if (elements.storageNotice.hidden) return;

  const canInstall = canPromptInstall();
  elements.installApp.hidden = !canInstall;
  elements.storageNoticeText.textContent = canInstall
    ? "Рецензии хранятся в этом браузере. Установите приложение — тогда браузер не удалит их при нехватке места."
    : isAppleMobile()
      ? "Рецензии хранятся в этом браузере. Safari очищает данные сайтов, которыми не пользовались неделю: добавьте приложение на экран «Домой» через меню «Поделиться»."
      : "Рецензии хранятся в этом браузере. Добавьте страницу в закладки или установите приложение, чтобы браузер их не удалял.";
}

function familySize(familyId) {
  return state.documents.filter((doc) => doc.familyId === familyId).length;
}

// Текст статьи попадает в приложение двумя путями — файлом и вставкой, — но
// документом становится одинаково: по содержимому, а не по способу доставки.
async function ingestText(text, name, versionTarget = null) {
  const sha256 = await sha256Hex(text);

  // Тот же текст — тот же документ: иначе список за месяц зарастёт копиями,
  // а рецензия к каждой копии начнётся заново.
  let known = state.documents.find((doc) => doc.sha256 === sha256) ?? null;
  if (!known) {
    const stored = await findByHash(sha256);
    if (stored) {
      known = restoreDocument(stored, await loadReview(stored.id));
      state.documents.push(known);
    }
  }
  if (known) {
    showToast(`«${known.name}» уже открыт — показана прежняя рецензия.`);
    return known;
  }

  const id = crypto.randomUUID();
  const family = versionTarget ?? id;
  const doc = {
    id,
    name,
    text,
    sha256,
    familyId: family,
    version: familySize(family) + 1,
    createdAt: Date.now(),
    lineData: splitPhysicalLines(text),
    entries: [],
    sequence: 0,
  };
  state.documents.push(doc);
  await persistDocument(doc);
  return doc;
}

async function loadFiles(fileList) {
  const files = [...fileList];
  const versionTarget = state.versionTarget;
  state.versionTarget = null;
  if (!files.length) return;
  let lastLoaded = null;
  for (const file of files) {
    if (!/\.(md|markdown)$/i.test(file.name)) {
      showToast(`Файл «${file.name}» пропущен: нужен .md или .markdown.`, "error");
      continue;
    }
    try {
      lastLoaded = (await ingestText(await file.text(), file.name, versionTarget)) ?? lastLoaded;
    } catch (error) {
      showToast(`Не удалось прочитать «${file.name}»: ${error.message}`, "error");
    }
  }
  elements.fileInput.value = "";
  if (lastLoaded) {
    activateDocument(lastLoaded.id);
    if (lastLoaded.version > 1) showToast(`Открыта версия ${lastLoaded.version}: «${lastLoaded.name}».`);
  }
}

// Имя различает статьи в списке и становится именем файла рецензии, поэтому
// символы, которые файловая система не примет, убираем сразу.
function cleanName(value) {
  return String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// У вставленного текста нет имени файла, а «Вставленный текст» в списке из
// нескольких статей бесполезен. Вводная часть объявляет заглавие явно, поэтому
// она главнее первого заголовка; переименовать вручную можно всегда.
function documentName(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const titled = front && /^title:\s*(.+)$/m.exec(front[1]);
  const heading = /^#{1,6}\s+(.+)$/m.exec(text);
  const raw = (titled?.[1] ?? heading?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  return cleanName(raw) || "Вставленный текст";
}

async function openPastedText(text) {
  const versionTarget = state.versionTarget;
  state.versionTarget = null;
  try {
    const doc = await ingestText(text, documentName(text), versionTarget);
    if (doc) activateDocument(doc.id);
  } catch (error) {
    showToast(`Не удалось открыть текст: ${error.message}`, "error");
  }
}

function openPasteDialog() {
  elements.pasteInput.value = "";
  elements.pasteDialog.showModal();
  elements.pasteInput.focus();
}

// Буфер читаем сразу в обработчике нажатия: любое ожидание до вызова стирает
// пользовательский жест, без которого браузер читать буфер не даёт. Firefox и
// Safari вдобавок показывают собственное меню «Вставить» — отказ от него, запрет
// в настройках и отсутствие самого метода приходят сюда одинаково, и на каждый
// случай остаётся один и тот же ответ: вставить руками.
function pasteFromClipboard() {
  const reading = navigator.clipboard?.readText?.();
  if (!reading?.then) {
    openPasteDialog();
    return;
  }
  reading.then(
    (text) => {
      // Пустая строка означает «в буфере нет текста», а не отказ: открывать
      // окно ручной вставки здесь не за чем — вставлять человеку нечего.
      if (!text?.trim()) {
        showToast("Нет текста в буфере.", "error");
        return;
      }
      openPastedText(text);
    },
    () => openPasteDialog(),
  );
}

// Имя из одних пробелов или из одних недопустимых символов после очистки пусто:
// сохранять нечего. Гасим «Сохранить», как и у общего замечания, — человек
// видит, что действие недоступно, вместо кнопки, которая молча не работает.
function syncRenameButton() {
  elements.submitRename.disabled = !cleanName(elements.renameInput.value);
}

function openRenameDialog() {
  const doc = activeDocument();
  if (!doc) return;
  elements.renameInput.value = doc.name;
  syncRenameButton();
  elements.renameDialog.showModal();
  elements.renameInput.select();
}

// Рецензия привязана к документу по его идентификатору, а не по имени, поэтому
// переименование её не задевает: меняется только то, что человек видит и
// получает в имени выгруженного файла.
async function renameActiveDocument() {
  const doc = activeDocument();
  const name = cleanName(elements.renameInput.value);
  if (!doc || !name) return;
  doc.name = name;
  elements.renameDialog.close();
  await persistDocument(doc);
  updateHeader();
  showToast(`Статья названа «${name}».`);
}

async function removeActiveDocument() {
  const doc = activeDocument();
  if (!doc) return;
  await forgetDocument(doc.id);
  state.documents = state.documents.filter((item) => item.id !== doc.id);
  state.activeDocumentId = state.documents.at(-1)?.id ?? null;
  state.draft = null;
  state.activeEntryId = null;
  updateHeader();
  renderFilters();
  renderReview();
  renderDocument();
  showToast(`Документ «${doc.name}» удалён.`);
}

// Blob.text() и FileReader идут к файлу разными путями и отказывают порознь,
// поэтому «не читается» говорим только после обеих попыток, а не после первой.
function readFileText(file) {
  return file.text().catch(
    (error) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? error);
        try {
          reader.readAsText(file);
        } catch {
          reject(error);
        }
      }),
  );
}

// Причина отказа приходит от браузера машинным именем — NotReadableError,
// NotFoundError, SecurityError. Человеку оно ничего не говорит само по себе, но
// именно оно отличает «файл унесли» от «доступ к папке закрыт», и без него
// разбираться приходится вслепую.
function readFailureReason(error) {
  const name = typeof error?.name === "string" ? error.name : "";
  if (name === "NotFoundError") return "файла нет на прежнем месте";
  if (name === "NotReadableError") return "система не дала доступ к файлу";
  if (name === "SecurityError") return "браузер закрыл доступ к файлу";
  return name || "браузер не объяснил причину";
}

// Установленное приложение — для системы отдельная программа, и доступ к
// папкам ей выдают отдельно от браузера, из которого её ставили. Отсюда случай,
// необъяснимый изнутри страницы: тот же адрес, тот же файл, во вкладке
// открывается, в приложении — нет. Совет должен вести туда, где это решается,
// а «попробуйте ещё раз» здесь не поможет никогда.
function installedAsApp() {
  return Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches);
}

function readFailureAdvice() {
  return installedAsApp()
    ? "Перетащите файл в это окно — перетаскиванию система доступ даёт; иначе разрешите приложению доступ к этой папке в настройках системы."
    : "Попробуйте ещё раз или откройте файл из другой папки.";
}

async function importReview(file) {
  const doc = activeDocument();
  if (!doc || !file) {
    elements.reviewInput.value = "";
    return;
  }

  // Читаем файл прежде, чем очистить поле: очистка отзывает право на выбранный
  // файл, и чтение после неё опирается на ссылку, которую браузер уже вправе не
  // принять. Поле всё равно нужно опустошить, чтобы повторный выбор того же
  // файла снова считался изменением, — но это дело последней строки, а не
  // первой, как было раньше.
  let text;
  try {
    text = await readFileText(file);
  } catch (error) {
    elements.reviewInput.value = "";
    showToast(
      `Файл не удалось прочитать: ${readFailureReason(error)}. ${readFailureAdvice()}`,
      "error",
    );
    return;
  }
  elements.reviewInput.value = "";
  await applyReviewText(text, doc);
}

// Разобранный текст рецензии приходит двумя путями — из выбранного файла и из
// перетащенного, — а дальше судьба у него одна, поэтому она и живёт отдельно от
// чтения.
async function applyReviewText(text, doc) {
  const parsed = parseReview(text);
  if (!parsed.entries.length) {
    showToast("В файле нет замечаний, которые удалось бы разобрать.", "error");
    return;
  }

  const foreign = parsed.document?.sha256 && parsed.document.sha256 !== doc.sha256;
  const maxSequence = parsed.entries.reduce((top, entry) => Math.max(top, entry.sequence ?? 0), 0);
  doc.entries = parsed.entries.map((entry) => ({
    ...entry,
    id: crypto.randomUUID(),
    status: "committed",
  }));
  doc.sequence = Math.max(doc.sequence, maxSequence);
  // Отказ записи не отменяет открытие: замечания уже разобраны и человеку
  // нужнее на экране, чем в хранилище. Но молчать о нём нельзя — рецензия,
  // которую не записали, исчезнет при следующем открытии приложения.
  const saved = await persistReview(doc);
  state.activeEntryId = null;
  state.edit = null;
  refreshReviewState();
  applyImportNotice(foreign ? parsed.document : null);
  // Сообщение одно, поэтому говорит о худшем из случившегося: о смещении строк
  // напоминает и заметка над списком, а о потерянной записи — больше ничто.
  showToast(
    !saved
      ? "Рецензия открыта, но не сохранена."
      : foreign
        ? "Рецензия открыта, но написана к другой версии статьи."
        : `Загружено ${pluralizeReview(doc.entries.length)}.`,
    saved && !foreign ? "info" : "error",
  );
}

function applyImportNotice(foreignDocument) {
  elements.importNotice.hidden = !foreignDocument;
  if (!foreignDocument) return;
  elements.importNotice.textContent = `Рецензия написана к другой версии статьи${
    foreignDocument.name ? ` («${foreignDocument.name}»)` : ""
  }. Привязка к строкам может быть смещена.`;
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
  const peers = lineGroup(Number(span.dataset.sourceLine));
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
  return indexedLine(line)?.spans ?? [];
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

function showQuoteToolbar(info, focus = false, origin = null) {
  if (!info?.quote?.trim()) return;
  state.pendingSelection = info;
  state.quoteOrigin = origin;
  const paneRect = elements.documentPane.getBoundingClientRect();
  const left = Math.max(12, info.rect.left - paneRect.left + elements.documentPane.scrollLeft);
  const top = Math.max(12, info.rect.top - paneRect.top + elements.documentPane.scrollTop - 48);
  elements.quoteToolbar.style.left = `${left}px`;
  elements.quoteToolbar.style.top = `${top}px`;
  elements.quoteToolbar.hidden = false;
  if (focus) elements.quoteToolbar.querySelector("button")?.focus({ preventScroll: true });
}

// Панель живёт ровно столько, сколько живёт выделение, которое её вызвало:
// закрывая её, забываем и это выделение, иначе следующее нажатие создало бы
// замечание к цитате, которую человек уже отменил.
function hideQuoteToolbar({ restoreFocus = false } = {}) {
  if (elements.quoteToolbar.hidden) return;
  const origin = state.quoteOrigin;
  const held = elements.quoteToolbar.contains(document.activeElement);
  elements.quoteToolbar.hidden = true;
  state.pendingSelection = null;
  state.quoteOrigin = null;
  // Панель, открытую с клавиатуры, человек закрывает вслепую: если не вернуть
  // фокус на строку, он окажется в начале документа.
  if (restoreFocus && held && origin?.isConnected) origin.focus({ preventScroll: true });
}

function handleDocumentScroll() {
  // Метки держатся за место в тексте, а не за экран: при прокрутке они едут
  // вместе с цитатой, а не исчезают вслед за панелью создания замечания.
  scheduleHandleUpdate();
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

// Выделив место и назвав тип, человек уже сказал главное: замечание есть.
// Ждать от него ещё и нажатия «Добавить» незачем — запись создаётся сразу и
// сразу открыта для письма. Передумал — удаляет её крестиком, как всякую
// другую; привязанное замечание осмысленно и без слов.
function createAnchoredEntry(type) {
  const doc = activeDocument();
  const selected = state.pendingSelection;
  if (!doc || !selected) return;
  const entry = {
    id: crypto.randomUUID(),
    documentId: doc.id,
    kind: "anchored",
    status: "committed",
    type,
    quote: asTyped(selected.quote),
    comment: "",
    replacement: "",
    startLine: selected.startLine,
    startColumn: selected.startColumn,
    endLine: selected.endLine,
    endColumn: selected.endColumn,
    sequence: nextSequence(doc),
  };
  doc.entries.push(entry);
  window.getSelection()?.removeAllRanges();
  hideQuoteToolbar();
  state.activeEntryId = entry.id;
  state.edit = { id: entry.id, type, comment: "", replacement: "", fresh: true };
  refreshReviewState({ focus: "#edit-comment" });
  persistReview(doc, { failed: "Замечание добавлено, но не сохранено." });
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
  refreshReviewState({ focus: "#draft-comment" });
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
  // Общее замечание без текста пусто целиком — добавлять нечего. Кнопка в этот
  // момент и так неактивна, поэтому отдельной надписи об ошибке не нужно:
  // человек видит, что действие недоступно, и понимает почему.
  if (state.draft.kind === "free" && !state.draft.comment.trim()) return;
  const committed = { ...state.draft, status: "committed", comment: state.draft.comment.trim() };
  if (committed.kind === "anchored") committed.replacement = committed.replacement.trim();
  doc.entries.push(committed);
  state.draft = null;
  state.activeEntryId = committed.kind === "anchored" ? committed.id : null;
  refreshReviewState();
  const what = committed.kind === "anchored" ? "Замечание" : "Общее замечание";
  persistReview(doc, {
    saved: `${what} сохранено.`,
    failed: `${what} добавлено, но не сохранено.`,
  });
}

function cancelDraft() {
  state.draft = null;
  refreshReviewState();
}

// Замечание пишут по ходу чтения и нередко потом перечитывают: формулировка
// оказывается резкой, тип — неточным, замена — с опечаткой. Раньше оставалось
// удалить запись и написать её заново, потеряв и место в рецензии, и цитату.
function startEdit(id, field = "comment") {
  const entry = activeDocument()?.entries.find((item) => item.id === id);
  if (!entry) return;
  if (state.edit?.id === id) return;
  if (state.draft) {
    showToast("Сначала добавьте или отмените текущий черновик.", "error");
    elements.reviewList.querySelector("#draft-comment")?.focus();
    return;
  }
  state.edit = {
    id: entry.id,
    type: entry.type ?? REVIEW_TYPES[0],
    comment: entry.comment ?? "",
    replacement: entry.replacement ?? "",
  };
  if (entry.kind === "anchored") state.activeEntryId = entry.id;
  refreshReviewState({ focus: field === "replacement" ? "#edit-replacement" : "#edit-comment" });
}

function syncEditFields() {
  if (!state.edit) return;
  const comment = elements.reviewList.querySelector("#edit-comment");
  const replacement = elements.reviewList.querySelector("#edit-replacement");
  if (comment) state.edit.comment = comment.value;
  if (replacement) state.edit.replacement = replacement.value;
}

// Написанное сохраняется по ходу письма, поэтому запись обновляется на месте:
// перерисовать список — значит выбить у человека из-под рук поле и курсор.
// Всё, что вне формы — счётчики, фильтры, цвет цитаты в тексте, — обновляется.
let editSaveTimer = 0;

function saveEditQuietly() {
  const doc = activeDocument();
  if (!doc || !state.edit) return;
  syncEditFields();
  const entry = doc.entries.find((item) => item.id === state.edit.id);
  if (!entry) return;
  const comment = state.edit.comment.trim();
  // Общее замечание состоит из одного текста: опустошив его, человек стёр бы
  // саму запись, не нажав «Удалить». Пустое поле просто не записывается.
  if (entry.kind === "free" && !comment) return;

  entry.comment = comment;
  if (entry.kind === "anchored") {
    if (REVIEW_TYPES.includes(state.edit.type)) entry.type = state.edit.type;
    entry.replacement = state.edit.replacement.trim();
  }
  updateHeader();
  renderFilters();
  applyAnnotationMarkers();
  persistReview(doc);
}

function scheduleEditSave() {
  clearTimeout(editSaveTimer);
  editSaveTimer = setTimeout(saveEditQuietly, 600);
}

function commitEdit() {
  clearTimeout(editSaveTimer);
  const doc = activeDocument();
  if (!doc || !state.edit) return;
  syncEditFields();
  const entry = doc.entries.find((item) => item.id === state.edit.id);
  if (!entry) {
    state.edit = null;
    refreshReviewState();
    return;
  }

  const comment = state.edit.comment.trim();
  // Общее замечание состоит из одного текста: опустошив его, человек стёр бы
  // саму запись, не нажав «Удалить». Правка тогда не принимается, но и держать
  // человека в форме нельзя — запись возвращается к прежнему тексту.
  if (entry.kind === "free" && !comment) {
    state.edit = null;
    refreshReviewState();
    showToast("Общее замечание состоит из текста: пустым оно не сохраняется.", "error");
    return;
  }

  entry.comment = comment;
  if (entry.kind === "anchored") {
    if (REVIEW_TYPES.includes(state.edit.type)) entry.type = state.edit.type;
    entry.replacement = state.edit.replacement.trim();
  }
  // Замечание, начатое выделением, для человека добавляется, а не изменяется:
  // сообщение называет то действие, которое он и совершил.
  const fresh = state.edit.fresh;
  state.edit = null;
  refreshReviewState();
  persistReview(doc, {
    saved: "Замечание сохранено.",
    failed: fresh ? "Замечание добавлено, но не сохранено." : "Замечание изменено, но не сохранено.",
  });
}

function deleteEntry(id) {
  const doc = activeDocument();
  if (!doc) return;
  const index = doc.entries.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  doc.entries.splice(index, 1);
  if (state.activeEntryId === id) state.activeEntryId = null;
  if (state.edit?.id === id) state.edit = null;
  refreshReviewState();
  persistReview(doc, {
    saved: "Запись удалена.",
    failed: "Запись удалена, но список не сохранён.",
  });
}

// Куда вести взгляд, зависит от того, откуда пришли: из панели — к месту в
// тексте, из текста — к карточке. Иначе половина пути делается вслепую: человек
// щёлкает по цитате и ищет глазами, где в длинном списке отозвалось.
function activateEntry(id, reveal = "document") {
  const entry = activeDocument()?.entries.find((item) => item.id === id);
  if (!entry || entry.kind !== "anchored") return;
  state.activeEntryId = id;
  // Замечание, щёлкнутое в тексте, показывается даже когда его тип снят
  // фильтром: иначе нажатие остаётся без ответа, а причина — в строке фильтров,
  // куда человек в этот момент не смотрит. Чип тут же загорается сам.
  if (reveal === "review") state.selectedTypes.add(entry.type);
  renderFilters();
  renderReview();
  applyAnnotationMarkers();
  if (reveal === "review") {
    const card = elements.reviewList.querySelector(`.review-card[data-entry-id="${CSS.escape(id)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const target = elements.documentBody.querySelector(`.source-line[data-source-line="${entry.startLine}"]`);
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Замечание под точкой. Диапазоны строятся только для записей, чьи строки
// накрывают ту, по которой щёлкнули: обходить всю рецензию ради одного нажатия
// незачем, а на длинной статье и накладно.
function rangeHasPoint(range, x, y) {
  for (const rect of range.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

function entryAtPoint(line, x, y) {
  let best = null;
  for (const entry of activeDocument()?.entries ?? []) {
    if (entry.kind !== "anchored") continue;
    if (line < entry.startLine || line > entry.endLine) continue;
    const range = anchorRange(entry);
    if (range && !rangeHasPoint(range, x, y)) continue;
    // Наложение разбирается в пользу самого узкого замечания: широкое человек
    // достанет и в другом месте, а точное иначе не выбрать вовсе. Замечание,
    // показанное пометкой строки целиком, точного края не имеет и в этом споре
    // проигрывает цитате.
    const width = range ? entry.quote.length : Number.POSITIVE_INFINITY;
    if (!best || width < best.width) best = { id: entry.id, width };
  }
  return best;
}

// Подсвеченные строки прошлого запроса: гасим только их, а не весь документ.
let highlightedLines = new Set();

function clearSearchClasses() {
  for (const line of highlightedLines) {
    for (const span of lineGroup(line)) {
      span.classList.remove("is-search-hit", "is-current-search-hit");
    }
  }
  highlightedLines = new Set();
}

function runSearch(query) {
  clearSearchClasses();
  state.searchResults = [];
  state.searchIndex = -1;
  const needle = asTyped(query).trim().toLocaleLowerCase("ru");
  if (!needle) {
    updateSearchCounter();
    return;
  }

  for (const [line, entry] of lineIndex) {
    const haystack = entry.text.toLocaleLowerCase("ru");
    let offset = haystack.indexOf(needle);
    if (offset < 0) continue;
    while (offset >= 0) {
      state.searchResults.push({ line, offset });
      offset = haystack.indexOf(needle, offset + Math.max(needle.length, 1));
    }
    highlightedLines.add(line);
    for (const span of entry.spans) span.classList.add("is-search-hit");
  }

  // Указатель наполняется по мере сборки, поэтому порядок совпадений в нём —
  // порядок строк в документе; сортировать нечего.
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

let currentHitLine = null;

function showCurrentSearchResult(scroll = true) {
  if (currentHitLine !== null) {
    for (const span of lineGroup(currentHitLine)) span.classList.remove("is-current-search-hit");
  }
  currentHitLine = state.searchResults[state.searchIndex]?.line ?? null;
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

const THEME_KEY = "marginalia:theme";

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark";
  elements.themeToggle.title = dark ? "Светлая тема" : "Тёмная тема";
  elements.themeToggle.querySelector(".sr-only").textContent = dark
    ? "Включить светлую тему"
    : "Включить тёмную тему";
}

function toggleTheme() {
  applyTheme(state.theme === "light" ? "dark" : "light");
  try {
    localStorage.setItem(THEME_KEY, state.theme);
  } catch {
    // Хранилище запрещено — тема просто не переживёт перезагрузку.
  }
}

// Работа переживает перезагрузку, и выбранная тема тоже должна: возвращаться
// каждый вечер к светлому экрану, однажды выбрав тёмный, — мелкая, но заметная
// несуразность.
function restoreTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    saved = null;
  }
  if (saved === "dark" || saved === "light") applyTheme(saved);
}

elements.openFiles.addEventListener("click", () => elements.fileInput.click());
elements.openFilesEmpty.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => loadFiles(elements.fileInput.files));

// Установленному приложению система закрывает «Загрузки», «Рабочий стол» и
// «Документы»: доступ к ним выдают ему отдельно от браузера, из которого его
// ставили, а спросить разрешение оно не умеет — файл, выбранный в системной
// панели, просто не читается. Перетаскивание идёт мимо этого запрета: право на
// файл даёт сам жест. Поэтому окно принимает файл там, где кнопка уже отказала,
// и об этом же говорит совет при отказе чтения.
const REVIEW_MARK = /<!--\s*marginalia:\d+/;

function draggingFiles(transfer) {
  return [...(transfer?.types ?? [])].includes("Files");
}

function markdownFiles(transfer) {
  const files = transfer?.files ? [...transfer.files] : [];
  return files.filter((file) => /\.(md|markdown)$/i.test(file.name));
}

async function openDroppedFiles(files) {
  for (const file of files) {
    let text;
    try {
      text = await readFileText(file);
    } catch (error) {
      showToast(
        `Не удалось прочитать «${file.name}»: ${readFailureReason(error)}. ${readFailureAdvice()}`,
        "error",
      );
      continue;
    }
    // Рецензию узнаём по машинному блоку, а не по имени файла: имя зависит от
    // того, кто его сохранял, а блок в рецензии есть всегда.
    const doc = activeDocument();
    if (doc && REVIEW_MARK.test(text)) {
      await applyReviewText(text, doc);
      continue;
    }
    const loaded = await ingestText(text, file.name);
    if (loaded) activateDocument(loaded.id);
  }
}

document.addEventListener("dragover", (event) => {
  if (!draggingFiles(event.dataTransfer)) return;
  // Отменённый dragover — единственный способ сказать браузеру, что файл здесь
  // ждут: без него события drop не будет вовсе.
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

document.addEventListener("drop", (event) => {
  if (!draggingFiles(event.dataTransfer)) return;
  // Без этого Chrome откроет файл сам и унесёт окно приложения с собой.
  event.preventDefault();
  const files = markdownFiles(event.dataTransfer);
  if (!files.length) {
    showToast("Перетащите файл .md или .markdown.", "error");
    return;
  }
  openDroppedFiles(files).catch(() => showToast("Файл открыть не удалось.", "error"));
});

// Файл, открытый из Finder «через приложение», приходит не событием, а очередью
// запуска, и приходит однажды — при старте окна. Потребителя ставим сразу:
// поставленный позже не получит уже случившийся запуск. Право на файл здесь
// тоже даёт сама операция открытия, поэтому этот путь работает в папках,
// закрытых для системной панели выбора.
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    const handles = params?.files ?? [];
    const files = [];
    for (const handle of handles) {
      try {
        files.push(await handle.getFile());
      } catch (error) {
        showToast(`Не удалось открыть файл: ${readFailureReason(error)}.`, "error");
      }
    }
    if (files.length) await openDroppedFiles(files);
  });
}
elements.pasteText.addEventListener("click", pasteFromClipboard);
elements.submitPaste.addEventListener("click", () => {
  const text = elements.pasteInput.value;
  // В этом окне буфер ни при чём: человек смотрит на собственное пустое поле,
  // и говорить ему про буфер значило бы объяснять не то, что он видит.
  if (!text.trim()) {
    showToast("Поле пустое: вставьте текст статьи.", "error");
    elements.pasteInput.focus();
    return;
  }
  elements.pasteDialog.close();
  openPastedText(text);
});
elements.cancelPaste.addEventListener("click", () => elements.pasteDialog.close());
elements.closePaste.addEventListener("click", () => elements.pasteDialog.close());
elements.renameDocument.addEventListener("click", openRenameDialog);
elements.submitRename.addEventListener("click", renameActiveDocument);
elements.cancelRename.addEventListener("click", () => elements.renameDialog.close());
elements.closeRename.addEventListener("click", () => elements.renameDialog.close());
elements.renameInput.addEventListener("input", syncRenameButton);
elements.renameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    renameActiveDocument();
  }
});
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
elements.openReview.addEventListener("click", () => elements.reviewInput.click());
// Открытие рецензии — единственный путь, где приложение принимает чужой файл и
// тут же пишет его в хранилище, поэтому отказать здесь может многое. Обещание
// без этого перехвата отклонялось в пустоту: нажатая кнопка, выбранный файл и
// ничего на экране — состояние, из которого человеку нечего понять.
elements.reviewInput.addEventListener("change", () => {
  importReview(elements.reviewInput.files[0]).catch(() => {
    showToast("Рецензию открыть не удалось.", "error");
  });
});
elements.addVersion.addEventListener("click", () => {
  const doc = activeDocument();
  if (!doc) return;
  state.versionTarget = doc.familyId;
  elements.fileInput.click();
});
elements.deleteDocument.addEventListener("click", removeActiveDocument);

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
  if (state.edit) {
    if (event.target.id === "edit-comment") state.edit.comment = event.target.value;
    if (event.target.id === "edit-replacement") state.edit.replacement = event.target.value;
    // Записываем не на каждую букву: пауза в письме и есть тот момент, когда
    // написанное уже имеет смысл сохранять.
    scheduleEditSave();
    return;
  }
  if (!state.draft) return;
  if (event.target.id === "draft-comment") {
    state.draft.comment = event.target.value;
    // Перерисовать карточку целиком нельзя — под руками у человека пропадёт
    // фокус и место курсора, поэтому доступность кнопки меняем на месте.
    if (state.draft.kind === "free") {
      const commit = elements.reviewList.querySelector('[data-action="commit-draft"]');
      if (commit) commit.disabled = !event.target.value.trim();
    }
  }
  if (event.target.id === "draft-replacement") state.draft.replacement = event.target.value;
});

// Уход из формы завершает правку. Куда именно ушёл фокус, на самом focusout
// знать нельзя: клик по кнопке, которая фокус не берёт, отдаёт relatedTarget
// пустым. Поэтому смотрим, где фокус осел, когда все обработчики отработали.
elements.reviewList.addEventListener("focusout", (event) => {
  if (!state.edit || !event.target.closest(".edit-card")) return;
  setTimeout(() => {
    if (!state.edit) return;
    const open = elements.reviewList.querySelector(".edit-card");
    if (open?.contains(document.activeElement)) return;
    commitEdit();
  }, 0);
});

elements.reviewList.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.edit) {
    event.preventDefault();
    commitEdit();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && (state.draft || state.edit)) {
    event.preventDefault();
    if (state.draft) commitDraft();
    else commitEdit();
    return;
  }
  const field = event.target.closest('[data-action="edit-field"]');
  if (field && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    startEdit(field.dataset.entryId, field.dataset.field);
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
    // Открытую форму правки клик не переоткрывает: человек в ней печатает.
    if (card && card.dataset.entryId !== state.edit?.id) activateEntry(card.dataset.entryId);
    return;
  }
  const id = action.dataset.entryId;
  if (action.dataset.action === "activate") activateEntry(id);
  if (action.dataset.action === "edit") startEdit(id);
  if (action.dataset.action === "edit-field") startEdit(id, action.dataset.field);
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
    renderReview({ focus: "#draft-comment" });
  }
  if (action.dataset.action === "edit-type" && state.edit) {
    syncEditFields();
    state.edit.type = action.dataset.type;
    saveEditQuietly();
    renderReview({ focus: "#edit-comment" });
  }
});

elements.documentBody.addEventListener("mouseup", () => requestAnimationFrame(handleSelection));
// Замечание на холсте отзывается в панели: щёлкнув по подсвеченной цитате,
// человек спрашивает «что здесь написано», и ответ лежит в карточке.
elements.documentBody.addEventListener("click", (event) => {
  // Выделение под курсором — начало нового замечания, а не обращение к старому:
  // панель цитаты уже показана, и подменять её активацией нельзя.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  const span = sourceSpan(event.target);
  if (!span) return;
  const hit = entryAtPoint(Number(span.dataset.sourceLine), event.clientX, event.clientY);
  if (hit) activateEntry(hit.id, "review");
});
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
    showQuoteToolbar(wholeLineSelection(line), true, line);
  }
});

elements.quoteToolbar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-quote-type]");
  if (button) createAnchoredEntry(button.dataset.quoteType);
});
// Нажатие на саму панель не должно снимать выделение: браузер схлопнул бы его
// ещё на mousedown, панель ушла бы вместе с ним и клик не дошёл бы до кнопки.
elements.quoteToolbar.addEventListener("mousedown", (event) => event.preventDefault());

// Панель предлагает действие над выделением, поэтому исчезает вместе с ним —
// каким бы способом человек его ни снял: клавишей, щелчком мимо, новым
// выделением или уходом в другую часть приложения.
document.addEventListener("selectionchange", () => {
  if (elements.quoteToolbar.contains(document.activeElement)) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) hideQuoteToolbar();
});
document.addEventListener("pointerdown", (event) => {
  if (elements.quoteToolbar.contains(event.target)) return;
  hideQuoteToolbar();
});
document.addEventListener("focusin", (event) => {
  if (elements.quoteToolbar.contains(event.target)) return;
  if (elements.documentBody.contains(event.target)) return;
  hideQuoteToolbar();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideQuoteToolbar({ restoreFocus: true });
});
elements.documentPane.addEventListener("scroll", handleDocumentScroll, { passive: true });
window.addEventListener("resize", () => hideQuoteToolbar());

// Ширину панели тянут мышью, и события resize при этом нет: наблюдатель ловит и
// её, и окно, и убранное оглавление одним правилом. Строки при этом
// перекладываются, а метки стоят по координатам — без пересчёта они остались бы
// на месте прежней раскладки.
new ResizeObserver(scheduleHandleUpdate).observe(elements.documentPane);

setUpReadingScale({
  root: document.documentElement,
  smaller: elements.textSmaller,
  larger: elements.textLarger,
  // Кегль сменился — строки переложились, и метки границ надо ставить заново.
  onChange: scheduleHandleUpdate,
});

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

async function restoreWorkspace() {
  const stored = await listDocuments();
  if (!stored?.length) return;
  const reviews = await Promise.all(stored.map((item) => loadReview(item.id)));
  state.documents = stored.map((item, index) => restoreDocument(item, reviews[index]));
  activateDocument(state.documents.at(-1).id);
  // Возвращаясь к накопленной рецензии, человек должен видеть, насколько
  // надёжно она лежит, — а не только в тот сеанс, когда её создавал.
  state.persistent = await storageIsPersistent();
  showStorageNotice();
}

elements.dismissStorageNotice.addEventListener("click", () => {
  dismissStorageNotice();
  showStorageNotice();
});

elements.installApp.addEventListener("click", async () => {
  const accepted = await promptInstall();
  if (accepted) showToast("Приложение установлено. Рецензии теперь под защитой браузера.");
  showStorageNotice();
});
watchInstallOffer(showStorageNotice);

restoreTheme();
updateHeader();
renderFilters();
renderReview();
renderDocument();
restoreWorkspace();
noticeAfterUpdate(showToast);
// Занят — значит открыт черновик или форма правки: там лежит набранный текст,
// который перезагрузка унесла бы. Всё остальное приложение хранит само.
keepAppFresh(() => Boolean(state.draft || state.edit));
