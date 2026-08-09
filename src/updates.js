const VERSION_KEY = "marginalia:build";

// Регистрируем службу сами, без обёртки workbox-window: обновление не должно
// применяться к открытой вкладке. Человек может править рецензию прямо сейчас,
// и подмена кода под руками ему ничего хорошего не сделает — новая версия
// скачивается в фоне и вступает в силу, когда приложение закроют.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Служба недоступна (запрет, приватный режим) — приложение работает
      // как обычная страница, просто без офлайна.
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
