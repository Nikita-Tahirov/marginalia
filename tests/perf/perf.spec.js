import { expect, test } from "@playwright/test";
import { buildArticle } from "./article.js";

// Порог отклика: задача главного потока длиннее этого времени успевает стать
// заметной паузой. Значение взято из индустриальной нормы INP «good» (web.dev,
// 02.09.2025): 200 мс.
const LONG_TASK_LIMIT_MS = 200;

// Целевое устройство — слабый планшет 2018 года: примерно вшестеро медленнее
// машины, на которой писался этот замер.
const TARGET_SLOWDOWN = 6;

// Эталон калибровки: время фиксированной счётной петли на машине разработки
// (медиана 3 прогонов, 10.08.2026). Множитель замедления считается от него,
// иначе на более медленной машине сборки к её собственной медлительности
// добавилось бы полное шестикратное замедление, и проверка падала бы не из-за
// приложения, а из-за железа.
const CALIBRATION_BASELINE_MS = 15;

function calibrationLoop() {
  const started = performance.now();
  let accumulator = 0;
  for (let index = 0; index < 5_000_000; index += 1) {
    accumulator = (accumulator + index * 31) % 1_000_003;
  }
  return { ms: performance.now() - started, accumulator };
}

async function calibrate(page) {
  const samples = [];
  for (let pass = 0; pass < 3; pass += 1) {
    samples.push((await page.evaluate(calibrationLoop)).ms);
  }
  samples.sort((left, right) => left - right);
  const median = samples[1];
  const rate = (TARGET_SLOWDOWN * CALIBRATION_BASELINE_MS) / median;
  return { median: Math.round(median), rate: Math.max(1, Math.min(TARGET_SLOWDOWN, rate)) };
}

async function throttle(page, rate) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
  return session;
}

async function watchLongTasks(page) {
  await page.evaluate(() => {
    window.__longTasks = [];
    window.__longTaskObserver?.disconnect();
    window.__longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
    });
    window.__longTaskObserver.observe({ type: "longtask", buffered: true });
  });
}

async function collectLongTasks(page) {
  // Наблюдатель сообщает о задаче в следующем кадре: без этой уступки
  // последняя — обычно самая длинная — задача не успевает попасть в список.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
  const tasks = await page.evaluate(() => window.__longTasks ?? []);
  return { tasks, longest: tasks.length ? Math.max(...tasks) : 0 };
}

async function openArticle(page, lines, name) {
  await page.locator("#file-input").setInputFiles({
    name,
    mimeType: "text/markdown",
    buffer: Buffer.from(buildArticle(lines)),
  });
  await expect(page.locator("#document-meta")).toHaveText(`${lines} строк`, { timeout: 600_000 });
}

// Режим отчёта нужен, чтобы снять полную картину «до» правки: иначе первое же
// превышение останавливает прогон и остальные величины остаются неизвестными.
// По умолчанию проверка строгая; режим включается только явной переменной.
const REPORT_ONLY = process.env.PERF_REPORT_ONLY === "1";

function report(title, measurement) {
  const line = `${title}: самая длинная задача ${measurement.longest} мс, всего длинных задач ${measurement.tasks.length}, порог ${LONG_TASK_LIMIT_MS} мс`;
  test.info().annotations.push({ type: "измерение", description: line });
  console.log(line);
}

function requireWithinLimit(measurement) {
  if (REPORT_ONLY) return;
  expect(measurement.longest).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS);
}

test.describe("отзывчивость на слабом устройстве", () => {
  test("открытие статьи не блокирует главный поток", async ({ page }) => {
    test.setTimeout(900_000);
    await page.goto("/");
    const calibration = await calibrate(page);
    console.log(
      `калибровка: эталонная петля ${calibration.median} мс, множитель замедления ${calibration.rate.toFixed(2)}×`,
    );
    await throttle(page, calibration.rate);

    for (const lines of [2000, 20000]) {
      await watchLongTasks(page);
      await openArticle(page, lines, `perf-${lines}.md`);
      const measurement = await collectLongTasks(page);
      report(`открытие статьи ${lines} строк`, measurement);
      requireWithinLimit(measurement);
    }
  });

  test("работа с замечаниями и поиск остаются отзывчивыми", async ({ page }) => {
    test.setTimeout(900_000);
    await page.goto("/");
    const calibration = await calibrate(page);
    await throttle(page, calibration.rate);
    await openArticle(page, 20000, "perf-actions.md");

    await watchLongTasks(page);
    const line = page.locator('.source-line.line-origin[data-source-line="120"]').first();
    await line.scrollIntoViewIfNeeded();
    await line.focus();
    await line.press("Enter");
    await expect(page.locator("#quote-toolbar")).toBeVisible();
    await page.locator('#quote-toolbar [data-quote-type="Правка"]').click();
    await page.locator("#draft-comment").fill("Замечание для замера отклика.");
    await page.locator('[data-action="commit-draft"]').click();
    await expect(page.locator(".review-card")).toHaveCount(1);
    const editing = await collectLongTasks(page);
    report("цитирование строки и добавление замечания", editing);
    requireWithinLimit(editing);

    await watchLongTasks(page);
    await page.locator("#search-input").fill("методологию");
    await expect(page.locator("#search-counter")).not.toHaveText("0 / 0");
    const searching = await collectLongTasks(page);
    report("поиск по документу", searching);
    requireWithinLimit(searching);

    await watchLongTasks(page);
    await page.locator('.review-card [data-action="delete"]').click();
    await expect(page.locator(".review-card")).toHaveCount(0);
    const deleting = await collectLongTasks(page);
    report("удаление замечания", deleting);
    requireWithinLimit(deleting);
  });
});
