import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test } from "@playwright/test";

// Заголовки живут в firebase.json и потому не видны обычному браузерному
// прогону: тот идёт против сервера разработки, который ни о какой политике не
// знает. Строгая политика, выкаченная вслепую, ломает приложение у человека,
// чья рецензия лежит недописанной, — поэтому здесь поднимается статический
// сервер над собранной сборкой, отдающий ровно те заголовки, что уйдут в
// рабочую среду, и по нему проходит настоящий сценарий.
const ROOT = new URL("../../", import.meta.url).pathname;
const DIST = join(ROOT, "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function hostingConfig() {
  const raw = JSON.parse(await readFile(join(ROOT, "firebase.json"), "utf8"));
  return raw.hosting[0];
}

// Firebase сопоставляет путь с глоб-образцом; здесь достаточно трёх форм,
// которые в конфигурации действительно встречаются.
function matches(source, path) {
  if (source === "**") return true;
  if (source.endsWith("/**")) return path.startsWith(source.slice(0, -2));
  return source === path;
}

function headersFor(config, path) {
  const collected = {};
  for (const rule of config.headers ?? []) {
    if (!matches(rule.source, path)) continue;
    for (const { key, value } of rule.headers) collected[key] ??= value;
  }
  return collected;
}

async function startServer(config) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const relative = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    let file;
    let served = relative;
    try {
      file = await readFile(join(DIST, relative));
    } catch {
      served = "/index.html";
      file = await readFile(join(DIST, "index.html"));
    }
    const type = MIME[extname(served)] ?? "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, ...headersFor(config, path) });
    response.end(file);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test("the policy names the hash of the script that is actually shipped", async () => {
  const config = await hostingConfig();
  const html = await readFile(join(DIST, "index.html"), "utf8");
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  expect(inline.length, "инлайновых скриптов в сборке").toBe(1);

  const digest = createHash("sha256").update(inline[0][1]).digest("base64");
  const policy = headersFor(config, "/index.html")["Content-Security-Policy"];
  // Скрипт правят — хеш обязан переехать вместе с ним, иначе рабочий адрес
  // молча перестанет исполнять перенаправление между двумя именами сайта.
  expect(policy, "хеш инлайнового скрипта в политике").toContain(`'sha256-${digest}'`);
});

test("the app survives its own security headers", async ({ page }) => {
  const config = await hostingConfig();
  const { server, origin } = await startServer(config);
  const violations = [];
  const failures = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  page.on("pageerror", (error) => failures.push(String(error)));

  try {
    // Подготовка действует на следующий переход, поэтому идёт до него: иначе
    // выгрузка уходит в системный диалог выбора файла и событие не приходит.
    await page.addInitScript(() => {
      delete window.showSaveFilePicker;
    });
    const response = await page.goto(origin);
    const sent = response.headers();
    expect(sent["content-security-policy"]).toContain("default-src 'none'");
    expect(sent["x-content-type-options"]).toBe("nosniff");
    expect(sent["referrer-policy"]).toBe("no-referrer");
    expect(sent["permissions-policy"]).toContain("camera=()");

    await page.locator("#file-input").setInputFiles({
      name: "article.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Заголовок\n\nПервая строка.\n\nВторая строка.\n"),
    });
    await expect(page.locator("#document-body")).toHaveAttribute("data-rendered", "complete");

    // Стили и шрифты приходят с того же источника, один шрифт — из data:.
    // Пустая ширина строки означала бы, что политика их не пустила.
    const width = await page.evaluate(
      () => document.querySelector(".source-line").getBoundingClientRect().width,
    );
    expect(width).toBeGreaterThan(0);

    // Политика с опечаткой браузером просто игнорируется, и проверка выше
    // прошла бы, ничего не проверив. Поэтому отдельно показываем, что она
    // действует: скрипт без объявленного хеша исполниться не должен.
    const smuggled = await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__cspIsOff = true";
      document.head.append(script);
      return window.__cspIsOff ?? null;
    });
    expect(smuggled, "политика должна отклонить чужой инлайновый скрипт").toBeNull();
    violations.length = 0;

    const source = page.locator('.source-line.line-origin[data-source-line="3"]').first();
    await source.focus();
    await source.press("Enter");
    await page.locator('#quote-toolbar [data-quote-type="Правка"]').click();
    await page.locator("#edit-comment").fill("Замечание под политикой.");
    await page.locator("#edit-comment").press("Control+Enter");
    await expect(page.locator(".review-card")).toHaveCount(1);

    // Выгрузка идёт через blob: — ровно тот случай, где строгая политика умеет
    // сломать функцию, не сказав об этом в консоли.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#save-review").click(),
    ]);
    expect(await download.failure()).toBeNull();

    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // Служба обновления живёт под worker-src: без него офлайн просто исчезает.
    const worker = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration);
    });
    expect(worker, "служба обновления зарегистрирована").toBe(true);

    expect(violations, "нарушения политики в консоли").toEqual([]);
    expect(failures, "исключения страницы").toEqual([]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
