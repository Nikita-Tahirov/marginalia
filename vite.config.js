import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Отметка сборки: по ней приложение узнаёт, что открылось уже обновлённым,
  // и говорит об этом человеку — вместо того чтобы менять код под руками.
  define: { __APP_BUILD__: JSON.stringify(String(Date.now())) },
  plugins: [
    VitePWA({
      // Новая версия скачивается в фоне и вступает в силу при следующем
      // открытии: подменять код под руками у человека, который правит рецензию,
      // нельзя. О состоявшемся обновлении приложение сообщает само.
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["icon.svg", "apple-touch-icon.png", "robots.txt"],
      manifest: {
        name: "Маргиналии",
        short_name: "Маргиналии",
        description: "Рецензирование Markdown-документов с привязкой к строкам",
        lang: "ru",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f3f2f2",
        theme_color: "#201f1d",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // Установленному приложению система закрывает «Загрузки», «Рабочий стол»
        // и «Документы»: файл, выбранный в её же панели, оно прочитать не может.
        // Открытие «через приложение» из Finder идёт другим путём — право на
        // файл выдаёт сама операция открытия, — поэтому статью и рецензию можно
        // отдать приложению оттуда, где они лежат.
        file_handlers: [
          {
            action: "/",
            accept: { "text/markdown": [".md", ".markdown"] },
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2,svg,png}"],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
});
