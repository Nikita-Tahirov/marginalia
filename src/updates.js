const VERSION_KEY = "marginalia:build";

// Как часто спрашивать сервер, не вышла ли новая версия. Без этого браузер
// сверяет службу только при переходах, а вкладку с рецензией держат открытой
// днями — и она неделю показывает то, чего давно нет.
const POLL_MS = 30 * 60 * 1000;

let registration = null;
let isBusy = () => false;

// Применяем ожидающую версию сами, но не под руками: пока открыт черновик или
// форма правки, перезагрузка стёрла бы набранное. Ждём минуты, когда человек
// ничего не пишет и не смотрит на вкладку, — он уходит на старой версии, а
// возвращается уже на новой, и рывка на глазах не происходит.
//
// Условие вынесено отдельно и без обращения к DOM: ослабить его — значит
// вернуть перезагрузку посреди написанного замечания, и это должно ломать
// проверку, а не всплывать у человека.
export function safeToApply({ waiting, busy, hidden }) {
  return Boolean(waiting) && !busy && hidden;
}

function applyIfSafe() {
  const waiting = registration?.waiting;
  if (!safeToApply({ waiting, busy: isBusy(), hidden: document.hidden })) return;
  waiting.postMessage({ type: "SKIP_WAITING" });
}

function watch(current) {
  registration = current;

  // Перезагружаемся ровно один раз и только по факту смены службы: событие
  // приходит и от чужой вкладки, применившей обновление раньше нас.
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  // Версия могла скачаться в прошлый визит и ждать до сих пор.
  applyIfSafe();

  current.addEventListener("updatefound", () => {
    const installing = current.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") applyIfSafe();
    });
  });

  document.addEventListener("visibilitychange", applyIfSafe);
  window.setInterval(() => {
    current.update().catch(() => {
      // Сети нет — приложение продолжает работать на том, что уже скачано.
    });
  }, POLL_MS);
}

// Принимает признак занятости: приложение само знает, пишет ли сейчас человек
// замечание. Служба об этом судить не может, а решать за неё нельзя.
export function keepAppFresh(busy) {
  if (typeof busy === "function") isBusy = busy;
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then(watch).catch(() => {
      // Служба недоступна (запрет, приватный режим) — приложение работает
      // как обычная страница, просто без офлайна и без самообновления.
    });
  });
}

// О состоявшемся обновлении сообщаем постфактум, сверяя отметку сборки с той,
// что была при прошлом открытии. Первое открытие уведомления не показывает.
export function noticeAfterUpdate(announce) {
  let previous = null;
  try {
    previous = localStorage.getItem(VERSION_KEY);
    localStorage.setItem(VERSION_KEY, __APP_BUILD__);
  } catch {
    // Хранилище запрещено — молчим, работа приложения от этого не зависит.
    return;
  }
  if (previous && previous !== __APP_BUILD__) announce("Приложение обновлено.");
}
