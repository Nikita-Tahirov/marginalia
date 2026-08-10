import { defineConfig } from "@playwright/test";

export default defineConfig({
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Замеры производительности идут отдельным набором: у них своя длительность и
  // свой смысл отказа — не «поведение сломалось», а «стало медленнее порога».
  projects: [
    { name: "e2e", testDir: "./tests/e2e" },
    { name: "perf", testDir: "./tests/perf", fullyParallel: false, workers: 1 },
    // Заголовки безопасности задаются раздачей, а не приложением, поэтому этот
    // набор поднимает собственный сервер над собранной сборкой и не пользуется
    // общим адресом сервера разработки.
    { name: "headers", testDir: "./tests/headers" },
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm run dev --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
