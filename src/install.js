// Устойчивость хранилища браузер выдаёт не по просьбе, а по признакам доверия:
// вовлечённость, закладка, установленное приложение (web.dev/articles/persistent-storage).
// WebKit среди своих эвристик прямо называет открытие с домашнего экрана, и это
// же снимает семидневное правило очистки Safari. Значит установка — не украшение,
// а единственный доступный нам способ защитить чужую работу.

const DECLINED_KEY = "marginalia:persist-declined";

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

export function isInstalled() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
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
