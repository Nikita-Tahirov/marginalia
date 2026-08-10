// Устойчивость хранилища браузер выдаёт не по просьбе, а по признакам доверия:
// вовлечённость, закладка, установленное приложение (web.dev/articles/persistent-storage).
// WebKit среди своих эвристик прямо называет открытие с домашнего экрана, и это
// же снимает семидневное правило очистки Safari. Значит установка — не украшение,
// а единственный доступный нам способ защитить чужую работу.

const DECLINED_KEY = "marginalia:persist-declined";
const INSTALLED_KEY = "marginalia:installed";
const NOTICE_KEY = "marginalia:storage-notice-dismissed";

let deferredPrompt = null;

// Firefox спрашивает разрешение у человека диалогом. Переспрашивать его в каждом
// сеансе — навязчивость; отказ запоминаем. В Chromium решает эвристика без
// участия человека, поэтому там повтор безвреден и со временем срабатывает.
export function persistDeclined() {
  try {
    return localStorage.getItem(DECLINED_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberPersistDecline() {
  if (!navigator.userAgent.includes("Firefox")) return;
  try {
    localStorage.setItem(DECLINED_KEY, "1");
  } catch {
    // Хранилище запрещено — переспросим в следующий раз, беды в этом нет.
  }
}

function readFlag(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Хранилище запрещено — признак не переживёт сеанс, но и вреда не будет.
  }
}

// Установленное приложение открывается не только своим окном: человек может
// вернуться и обычной вкладкой, где display-mode снова «browser». Поэтому
// однажды увиденную установку запоминаем, а не спрашиваем режим каждый раз.
// Режимов у окна приложения тоже несколько: строка заголовка и наложение
// системных кнопок дают не standalone, хотя приложение установлено.
const APP_DISPLAY_MODES = ["standalone", "minimal-ui", "fullscreen", "window-controls-overlay"];

export function isInstalled() {
  const running =
    APP_DISPLAY_MODES.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches) ||
    window.navigator.standalone === true;
  if (running) writeFlag(INSTALLED_KEY);
  return running || readFlag(INSTALLED_KEY);
}

// Полосу о хранилище человек вправе закрыть, не устанавливая приложение:
// он предупреждён, и повторять это при каждом открытии незачем.
export function storageNoticeDismissed() {
  return readFlag(NOTICE_KEY);
}

export function dismissStorageNotice() {
  writeFlag(NOTICE_KEY);
}

// Safari не поддерживает beforeinstallprompt, поэтому там кнопки быть не может —
// только подсказка про меню «Поделиться».
export function isAppleMobile() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

export function watchInstallOffer(onChange) {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    onChange();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    // Событие приходит и в ту вкладку, из которой приложение поставили: с этой
    // минуты предупреждать о хрупкости хранилища больше не о чем.
    writeFlag(INSTALLED_KEY);
    onChange();
  });
}

export function canPromptInstall() {
  return deferredPrompt !== null;
}

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === "accepted";
}
