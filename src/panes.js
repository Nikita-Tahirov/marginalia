const root = document.documentElement;

const WIDTH_VARIABLES = { review: "--review-width", toc: "--toc-width" };
const WIDTH_LIMITS = { review: [300, 760], toc: [160, 460] };
const PANES = Object.keys(WIDTH_VARIABLES);
const STORAGE_KEY = "marginalia:pane-widths";
const TOC_KEY = "marginalia:toc-hidden";
const DOCUMENT_MIN_WIDTH = 320;
const KEYBOARD_STEP = 12;
const KEYBOARD_STEP_LARGE = 40;
const RESIZE_DELAY = 60;

const workspace = document.querySelector(".workspace");
const handles = [...document.querySelectorAll(".pane-resizer")].filter(
  (handle) => handle.dataset.resize in WIDTH_VARIABLES,
);

// Ширина, которую задал пользователь. Узкое окно временно ужимает панель, но
// заданное значение сохраняется и возвращается, когда место снова появляется.
const desiredWidths = { review: null, toc: null };

function otherPane(kind) {
  return kind === "review" ? "toc" : "review";
}

function resizerGap() {
  const single = parseFloat(getComputedStyle(root).getPropertyValue("--resizer-width"));
  return (Number.isFinite(single) ? single : 7) * 2;
}

function paneWidth(kind) {
  const value = parseFloat(getComputedStyle(root).getPropertyValue(WIDTH_VARIABLES[kind]));
  return Number.isFinite(value) ? value : WIDTH_LIMITS[kind][0];
}

function clampWidth(kind, width, otherWidth) {
  const [min, max] = WIDTH_LIMITS[kind];
  const workspaceWidth = workspace?.clientWidth || window.innerWidth;
  const available = workspaceWidth - resizerGap() - otherWidth - DOCUMENT_MIN_WIDTH;
  return Math.round(Math.max(min, Math.min(width, max, available)));
}

function syncHandle(kind) {
  const handle = handles.find((item) => item.dataset.resize === kind);
  handle?.setAttribute("aria-valuenow", String(Math.round(paneWidth(kind))));
}

function applyWidth(kind, width) {
  desiredWidths[kind] = width;
  root.style.setProperty(
    WIDTH_VARIABLES[kind],
    `${clampWidth(kind, width, paneWidth(otherPane(kind)))}px`,
  );
  syncHandle(kind);
}

function resetWidth(kind) {
  desiredWidths[kind] = null;
  root.style.removeProperty(WIDTH_VARIABLES[kind]);
  syncHandle(kind);
}

function persistWidths() {
  // Сброшенная панель не попадает в хранилище: иначе значение по умолчанию
  // закрепилось бы навсегда и перестало следовать ширине окна.
  const stored = Object.fromEntries(
    PANES.filter((kind) => desiredWidths[kind] !== null).map((kind) => [kind, desiredWidths[kind]]),
  );
  try {
    if (Object.keys(stored).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Запись недоступна (приватный режим, запрет хранилища) — раскладка просто
    // не переживёт перезагрузку, работа продолжается.
  }
}

function restoreWidths() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    saved = null;
  }

  for (const kind of PANES) {
    const width = saved?.[kind];
    if (Number.isFinite(width)) applyWidth(kind, width);
    else syncHandle(kind);
  }
}

let resizeTimer = 0;

function resyncPanes() {
  for (const kind of PANES) {
    // Заданную ширину пересчитываем от желаемого значения: окно могло и сузиться,
    // и снова расшириться. Ширину из медиазапроса только отражаем в атрибуте.
    if (desiredWidths[kind] !== null) applyWidth(kind, desiredWidths[kind]);
    else syncHandle(kind);
  }
}

function scheduleResync() {
  // Таймер, а не requestAnimationFrame: окно можно растянуть, пока вкладка
  // скрыта, а кадры в фоне не отрисовываются — пересчёт бы не состоялся.
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resyncPanes, RESIZE_DELAY);
}

function startDragging(handle, kind, event) {
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  handle.setAttribute("data-dragging", "");
  document.body.setAttribute("data-resizing", "");

  const startX = event.clientX;
  const startWidth = paneWidth(kind);

  const drag = (moveEvent) => {
    const delta = kind === "review" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
    applyWidth(kind, startWidth + delta);
  };

  const stop = () => {
    handle.removeEventListener("pointermove", drag);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    handle.removeAttribute("data-dragging");
    document.body.removeAttribute("data-resizing");
    persistWidths();
  };

  // Захват направляет дальнейшие события указателя самой ручке, поэтому
  // слушатели живут на ней, а не на документе.
  handle.addEventListener("pointermove", drag);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}

function nudge(kind, event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const delta = kind === "review" ? direction * step : -direction * step;
  applyWidth(kind, paneWidth(kind) + delta);
  persistWidths();
}

for (const handle of handles) {
  const kind = handle.dataset.resize;
  handle.addEventListener("pointerdown", (event) => startDragging(handle, kind, event));
  handle.addEventListener("keydown", (event) => nudge(kind, event));
  handle.addEventListener("dblclick", () => {
    resetWidth(kind);
    persistWidths();
  });
}

// Скрытое оглавление — такая же часть выбранной раскладки, как ширина панелей,
// и переживает перезагрузку по той же причине: человек настроил экран под себя
// один раз, а не на один сеанс.
const tocToggle = document.querySelector("#toggle-toc");

function applyTocVisibility(hidden) {
  root.dataset.tocHidden = hidden ? "true" : "false";
  if (!tocToggle) return;
  tocToggle.setAttribute("aria-pressed", hidden ? "false" : "true");
  tocToggle.setAttribute("aria-label", hidden ? "Показать оглавление" : "Скрыть оглавление");
}

function tocHidden() {
  return root.dataset.tocHidden === "true";
}

function restoreTocVisibility() {
  let saved = null;
  try {
    saved = localStorage.getItem(TOC_KEY);
  } catch {
    saved = null;
  }
  applyTocVisibility(saved === "true");
}

tocToggle?.addEventListener("click", () => {
  const hidden = !tocHidden();
  applyTocVisibility(hidden);
  try {
    localStorage.setItem(TOC_KEY, String(hidden));
  } catch {
    // Запись недоступна — оглавление просто вернётся при следующем открытии.
  }
  // Панель ушла или вернулась, значит доступная ширина изменилась: заявленные
  // ширины пересчитываем сразу, а не ждём, пока человек тронет окно.
  resyncPanes();
});

window.addEventListener("resize", scheduleResync);

restoreTocVisibility();
restoreWidths();
