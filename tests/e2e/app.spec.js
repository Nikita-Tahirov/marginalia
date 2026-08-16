import { expect, test } from "@playwright/test";

const article = `# Заголовок

Первая строка с целью.
Вторая строка содержит цель дважды: цель.

## Раздел

Заключительная строка.
`;

async function loadMarkdown(page, name = "article.md", text = article) {
  await page.locator("#file-input").setInputFiles({
    name,
    mimeType: "text/markdown",
    buffer: Buffer.from(text),
  });
  await expect(page.locator("#document-select")).toContainText(name);
}

async function quoteWholeLine(page, line, type = "Правка") {
  const source = page.locator(`.source-line.line-origin[data-source-line="${line}"]`).first();
  await source.focus();
  await source.press("Enter");
  await expect(page.locator("#quote-toolbar")).toBeVisible();
  await page.locator(`#quote-toolbar [data-quote-type="${type}"]`).click();
}

// Выделение мышью в собранном документе: ставим тот же диапазон, что даёт
// протяжка по тексту, и отпускаем кнопку там, где её слушает приложение.
async function quotePartOfLine(page, line, from, to, type = "Правка") {
  await page.evaluate(
    ({ line: target, from: start, to: end }) => {
      const span = document.querySelector(`.source-line[data-source-line="${target}"]`);
      const range = document.createRange();
      range.setStart(span.firstChild, start);
      range.setEnd(span.firstChild, end);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document
        .querySelector("#document-body")
        .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { line, from, to },
  );
  await expect(page.locator("#quote-toolbar")).toBeVisible();
  await page.locator(`#quote-toolbar [data-quote-type="${type}"]`).click();
}

async function highlightedFragments(page, name) {
  return page.evaluate(
    (highlight) => [...(CSS.highlights.get(highlight) ?? [])].map((range) => range.toString()),
    name,
  );
}

async function commitDraft(page, comment, replacement = "") {
  await page.locator("#draft-comment").fill(comment);
  if (replacement) await page.locator("#draft-replacement").fill(replacement);
  await page.locator('[data-action="commit-draft"]').click();
}

test("loads documents, searches and keeps per-document reviews", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await expect(page.locator("#document-meta")).toHaveText("9 строк");
  await expect(page.locator("#toc-list")).toContainText("Заголовок");
  await expect(page.locator("#toc-list")).toContainText("Раздел");

  await page.locator("#search-input").fill("цель");
  await expect(page.locator("#search-counter")).toHaveText("1 / 3");
  await page.locator("#search-next").click();
  await expect(page.locator("#search-counter")).toHaveText("2 / 3");

  await quoteWholeLine(page, 3, "Правка");
  await commitDraft(page, "Уточнить формулировку.", "Исправленная строка.");
  await expect(page.locator(".review-card")).toHaveCount(1);

  await loadMarkdown(page, "second.md", "# Второй\n\nТекст.\n");
  await expect(page.locator(".review-card")).toHaveCount(0);
  await page.locator("#document-select").selectOption({ label: "article.md · 9 стр." });
  await expect(page.locator(".review-card")).toContainText("Уточнить формулировку.");
});

test("creates all types and exports identical Markdown to clipboard and download", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4173" });
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  await page.goto("/");
  await loadMarkdown(page);

  for (const [index, type] of ["Правка", "Вопрос", "Удалить", "Переписать"].entries()) {
    await quoteWholeLine(page, index === 0 ? 3 : 4, type);
    await commitDraft(page, `Комментарий ${type}.`, type === "Правка" ? "Замена." : "");
  }
  await expect(page.locator("#review-count")).toHaveText("4 замечания");

  await page.locator('[data-filter-type="Вопрос"]').click();
  await expect(page.locator(".review-card")).toHaveCount(3);
  await page.locator('[data-filter-type="Вопрос"]').click();

  await page.locator("#preview-review").click();
  const expected = await page.locator("#preview-content").textContent();
  expect(expected).toContain("### Строка 3 · Правка");
  expect(expected).toContain("### Строка 4 · Вопрос");
  expect(expected).toContain("**Заменить на:** Замена.");
  await page.locator("#close-preview").click();

  await page.locator("#copy-review").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#save-review").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("article.review.md");
  const stream = await download.createReadStream();
  let downloaded = "";
  for await (const chunk of stream) downloaded += chunk.toString();
  expect(downloaded).toBe(expected);
});

test("save writes through the file picker and does nothing when the picker is cancelled", async ({ page }) => {
  await page.addInitScript(() => {
    window.__picker = { suggested: [], written: [], mode: "accept" };
    window.showSaveFilePicker = async (options) => {
      window.__picker.suggested.push(options.suggestedName);
      if (window.__picker.mode === "cancel") {
        const abort = new Error("Пользователь отменил выбор.");
        abort.name = "AbortError";
        throw abort;
      }
      return {
        createWritable: async () => ({
          write: async (data) => window.__picker.written.push(data),
          close: async () => {},
        }),
      };
    };
  });

  const downloads = [];
  page.on("download", (item) => downloads.push(item));

  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3);
  await commitDraft(page, "Замечание для сохранения.");

  await page.locator("#save-review").click();
  await expect(page.locator("#toast")).toHaveText("Рецензия сохранена.");
  const accepted = await page.evaluate(() => window.__picker);
  expect(accepted.suggested).toEqual(["article.review.md"]);
  expect(accepted.written).toHaveLength(1);
  expect(accepted.written[0]).toContain("### Строка 3 · Правка");

  await page.evaluate(() => {
    window.__picker.mode = "cancel";
  });
  await page.locator("#save-review").click();
  await expect
    .poll(() => page.evaluate(() => window.__picker.suggested.length))
    .toBe(2);
  expect(await page.evaluate(() => window.__picker.written.length)).toBe(1);
  expect(downloads).toHaveLength(0);
});

test("multiple free notes keep their visible place after anchored additions and deletion", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3);
  await commitDraft(page, "Опорное замечание.");

  await page.locator('[data-action="add-general-after"]').click();
  await commitDraft(page, "Свободная запись A.");
  await page.locator('.free-card [data-action="add-general-after"]').click();
  await commitDraft(page, "Свободная запись B.");

  await quoteWholeLine(page, 4, "Вопрос");
  await commitDraft(page, "Более позднее замечание.");
  await expect(page.locator(".review-card .card-comment")).toHaveText([
    "Опорное замечание.", "Свободная запись A.", "Свободная запись B.", "Более позднее замечание.",
  ]);

  await page.locator(".review-card").first().locator('[data-action="delete"]').click();
  await expect(page.locator(".review-card .card-comment")).toHaveText([
    "Свободная запись A.", "Свободная запись B.", "Более позднее замечание.",
  ]);

  await page.locator("#preview-review").click();
  await expect(page.locator("#preview-content")).toContainText("### Общее замечание");
});

test("maps real selections to source lines and sorts same-line selections by column", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page, "ranges.md", "# Тест\n\nabcdefghij\nklmnopqrst\n");

  const selectRange = async (startLine, startOffset, endLine, endOffset) => {
    await page.evaluate(({ startLine, startOffset, endLine, endOffset }) => {
      const start = document.querySelector(`.source-line[data-source-line="${startLine}"]`);
      const end = document.querySelector(`.source-line[data-source-line="${endLine}"]`);
      const range = document.createRange();
      range.setStart(start.firstChild, startOffset);
      range.setEnd(end.firstChild, endOffset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      start.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, { startLine, startOffset, endLine, endOffset });
    await expect(page.locator("#quote-toolbar")).toBeVisible();
  };

  await selectRange(3, 6, 3, 9);
  await page.locator('#quote-toolbar [data-quote-type="Вопрос"]').click();
  await commitDraft(page, "Поздний фрагмент.");

  await selectRange(3, 1, 3, 3);
  await page.locator('#quote-toolbar [data-quote-type="Правка"]').click();
  await commitDraft(page, "Ранний фрагмент.");
  await expect(page.locator(".review-card .card-comment")).toHaveText([
    "Ранний фрагмент.", "Поздний фрагмент.",
  ]);

  await selectRange(3, 8, 4, 3);
  await page.locator('#quote-toolbar [data-quote-type="Переписать"]').click();
  await commitDraft(page, "Диапазон строк.");
  await page.locator("#preview-review").click();
  await expect(page.locator("#preview-content")).toContainText("### Строки 3–4 · Переписать");
});

test("renders hostile Markdown without execution or document-originated requests", async ({ page }) => {
  await page.goto("/");
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await loadMarkdown(
    page,
    "hostile.md",
    `# Безопасность\n\n<script>window.__owned = true</script>\n\n[опасно](javascript:window.__owned=true)\n\n![слежение](https://example.invalid/pixel.png)\n\n<img src=x onerror="window.__owned=true">`,
  );

  expect(await page.evaluate(() => window.__owned)).toBeUndefined();
  await expect(page.locator("#document-body script, #document-body img")).toHaveCount(0);
  await expect(page.locator('#document-body a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator("#document-body")).toContainText("[Изображение: слежение]");
  expect(requests.some((url) => url.includes("example.invalid"))).toBe(false);
});

test("supports keyboard creation, activation, theme and empty or rejected files", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page, "empty.md", "");
  await expect(page.locator("#document-body")).toContainText("Документ пуст.");

  await page.locator("#file-input").setInputFiles({
    name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("text"),
  });
  await expect(page.locator("#toast")).toContainText("пропущен");

  await loadMarkdown(page);
  await quoteWholeLine(page, 3, "Вопрос");
  await page.locator("#draft-comment").fill("Клавиатурное замечание.");
  await page.locator("#draft-comment").press("Control+Enter");
  await expect(page.locator(".review-card")).toContainText("Клавиатурное замечание.");

  await page.locator(".review-card .card-comment").click();
  await expect(page.locator('[data-source-line="3"].is-active-annotation')).not.toHaveCount(0);
  await page.locator(".review-card").focus();
  await page.locator(".review-card").press("Enter");
  await expect(page.locator('[data-source-line="3"].is-active-annotation')).not.toHaveCount(0);

  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Раз работа переживает перезагрузку, выбранная тема тоже обязана.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("keeps the keyboard quote toolbar open on a deep document line", async ({ page }) => {
  await page.goto("/");
  const longDocument = Array.from({ length: 60 }, (_, index) => `Строка ${index + 1}`).join("\n");
  await loadMarkdown(page, "long.md", longDocument);

  const source = page.locator('.source-line.line-origin[data-source-line="37"]');
  await source.focus();
  await source.press("Enter");

  const firstType = page.locator('#quote-toolbar [data-quote-type="Правка"]');
  await expect(page.locator("#quote-toolbar")).toBeVisible();
  await expect(firstType).toBeFocused();
  await firstType.click();
  await commitDraft(page, "Замечание из глубины документа.");
  await expect(page.locator(".review-card")).toContainText("строка 37");

  await page.locator("#document-pane").evaluate((element) => element.scrollTo({ top: 0 }));
  await page.locator(".review-card blockquote").click();
  await expect(source).toHaveClass(/is-active-annotation/);
  await expect(source).toBeInViewport();
});

test("marks the quoted fragment, not the whole line it belongs to", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quotePartOfLine(page, 3, 7, 13);
  await commitDraft(page, "Замечание к части строки.");

  // Строка Markdown — это целый абзац, поэтому строчная пометка тут была бы
  // пометкой абзаца: подсвечена должна быть сама цитата. Только что созданное
  // замечание открыто, а открытое рисуется своим набором — поверх остальных.
  await expect(page.locator('[data-source-line="3"].is-annotated')).toHaveCount(0);
  expect(await highlightedFragments(page, "marginalia-note-active")).toEqual(["строка"]);
  expect(await highlightedFragments(page, "marginalia-note")).toEqual([]);

  // Границы цитаты переживают перезагрузку вместе с самой записью.
  await expect(page.locator("#save-state")).toHaveText("Сохранено");
  await page.reload();
  await expect(page.locator(".review-card")).toContainText("Замечание к части строки.");
  expect(await highlightedFragments(page, "marginalia-note")).toEqual(["строка"]);
  expect(await highlightedFragments(page, "marginalia-note-active")).toEqual([]);

  await page.locator(".review-card blockquote").click();
  expect(await highlightedFragments(page, "marginalia-note-active")).toEqual(["строка"]);
  expect(await highlightedFragments(page, "marginalia-note")).toEqual([]);

  // Рецензия, разобранная по тексту, границ внутри строки не несёт. Показывать
  // цитату по выдуманным границам нельзя — такая запись помечает строку целиком.
  await page.locator('.review-card [data-action="delete"]').click();
  await page.locator("#review-input").setInputFiles({
    name: "article.review.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("### Строка 3 · Правка\n\n> строка\n\nЗамечание из чужого файла.\n"),
  });
  await expect(page.locator(".review-card")).toContainText("Замечание из чужого файла.");
  await expect(page.locator('[data-source-line="3"].is-annotated')).not.toHaveCount(0);
  expect(await highlightedFragments(page, "marginalia-note")).toEqual([]);
});

test("keeps the review after the browser is closed and reopened", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3, "Вопрос");
  await commitDraft(page, "Замечание, которое обязано пережить перезагрузку.");
  await expect(page.locator(".review-card")).toHaveCount(1);
  await expect(page.locator("#save-state")).toHaveText("Сохранено");

  await page.reload();
  await expect(page.locator("#document-select")).toContainText("article.md");
  await expect(page.locator(".review-card")).toContainText(
    "Замечание, которое обязано пережить перезагрузку.",
  );
  // Привязка к строке восстановлена, а не потеряна вместе с разметкой.
  await expect(page.locator('[data-source-line="3"].is-annotated')).not.toHaveCount(0);

  // Тот же файл не заводит копию: рецензия продолжается, а не начинается заново.
  await loadMarkdown(page);
  await expect(page.locator("#document-select option")).toHaveCount(1);
  await expect(page.locator(".review-card")).toHaveCount(1);
});

test("adds a second version on request and deletes a document with its review", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3);
  await commitDraft(page, "Замечание к первой версии.");

  await page.locator("#add-version").click();
  await page.locator("#file-input").setInputFiles({
    name: "article.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(`${article}\nДописанный абзац.\n`),
  });
  await expect(page.locator("#document-select option")).toHaveCount(2);
  await expect(page.locator("#document-select")).toContainText("вер. 2");
  // Замечания на новую версию не переносятся: это осознанное решение, а не пропуск.
  await expect(page.locator(".review-card")).toHaveCount(0);

  await page.locator("#delete-document").click();
  await expect(page.locator("#document-select option")).toHaveCount(1);
  await expect(page.locator(".review-card")).toContainText("Замечание к первой версии.");

  await page.reload();
  await expect(page.locator("#document-select option")).toHaveCount(1);
});

test("reopens an exported review and warns when it belongs to another version", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 4, "Переписать");
  await commitDraft(page, "Замечание для выгрузки.");
  await page.locator("#preview-review").click();
  const exported = await page.locator("#preview-content").textContent();
  await page.locator("#close-preview").click();
  expect(exported).toContain("<!-- marginalia:1 ");

  // Своя статья: рецензия возвращается с привязкой и без предупреждения.
  await page.locator(".review-card [data-action=\"delete\"]").click();
  await expect(page.locator(".review-card")).toHaveCount(0);
  await page.locator("#review-input").setInputFiles({
    name: "article.review.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(exported),
  });
  await expect(page.locator(".review-card")).toContainText("Замечание для выгрузки.");
  await expect(page.locator('[data-source-line="4"].is-annotated')).not.toHaveCount(0);
  await expect(page.locator("#import-notice")).toBeHidden();

  // Чужая версия: рецензия всё равно открывается, но о смещении сказано прямо.
  await loadMarkdown(page, "other.md", "# Другая\n\nСовсем другой текст.\n");
  await page.locator("#review-input").setInputFiles({
    name: "article.review.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(exported),
  });
  await expect(page.locator(".review-card")).toContainText("Замечание для выгрузки.");
  await expect(page.locator("#import-notice")).toBeVisible();
  await expect(page.locator("#import-notice")).toContainText("другой версии статьи");
});

test("explains where the review lives only once there is something to lose", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#storage-notice")).toBeHidden();

  // Открытая статья ещё ничего не стоит: терять пока нечего.
  await loadMarkdown(page);
  await expect(page.locator("#storage-notice")).toBeHidden();

  await quoteWholeLine(page, 3);
  await commitDraft(page, "Замечание, которое жалко потерять.");
  await expect(page.locator("#storage-notice")).toBeVisible();
  await expect(page.locator("#storage-notice-text")).toContainText("хранятся в этом браузере");
});

test("stops warning about storage once the app is installed", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3);
  await commitDraft(page, "Замечание до установки.");
  await expect(page.locator("#storage-notice")).toBeVisible();

  // Событие приходит в ту вкладку, из которой приложение поставили.
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(page.locator("#storage-notice")).toBeHidden();

  // Установленное приложение открывают и обычной вкладкой, где display-mode
  // снова «browser»: предупреждение не должно возвращаться и там.
  await page.reload();
  await expect(page.locator(".review-card")).toContainText("Замечание до установки.");
  await expect(page.locator("#storage-notice")).toBeHidden();
});

test("lets the reader dismiss the storage warning for good", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3);
  await commitDraft(page, "Замечание без установки.");
  await expect(page.locator("#storage-notice")).toBeVisible();

  await page.locator("#dismiss-storage-notice").click();
  await expect(page.locator("#storage-notice")).toBeHidden();

  // Закрытое однажды не возвращается: человек предупреждён и решил иначе.
  await page.reload();
  await expect(page.locator(".review-card")).toContainText("Замечание без установки.");
  await expect(page.locator("#storage-notice")).toBeHidden();
});

test("announces an update once it has already been applied", async ({ page }) => {
  await page.goto("/");
  // Так выглядит возвращение человека, у которого приложение обновилось между
  // визитами: отметка прошлой сборки не совпадает с текущей.
  await page.evaluate(() => localStorage.setItem("marginalia:build", "предыдущая-сборка"));
  await page.reload();
  await expect(page.locator("#toast")).toHaveText("Приложение обновлено.");

  // Второе открытие уже ничего не сообщает: обновления не было.
  await page.reload();
  await expect(page.locator("#toast")).toBeHidden();
});

test("keeps working when the browser forbids storage", async ({ page }) => {
  // Приватное окно и запрет хранилища в настройках: рецензия не переживёт
  // закрытия вкладки, но работать в ней человек обязан как прежде.
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new DOMException("Хранилище запрещено", "SecurityError");
      },
    });
  });

  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3);
  await commitDraft(page, "Замечание без хранилища.");
  await expect(page.locator(".review-card")).toContainText("Замечание без хранилища.");
  await expect(page.locator("#save-state")).toHaveText("Не сохранено");

  await page.locator("#preview-review").click();
  await expect(page.locator("#preview-content")).toContainText("### Строка 3 · Правка");
  expect(errors).toEqual([]);
});

test("fits desktop and tablet widths without sideways scrolling", async ({ page }) => {
  await page.goto("/");
  // Имя настоящей статьи, а не короткое «article.md»: ширину поля определяет
  // длина имени, и на коротком теснота в шапке просто не проявляется.
  await loadMarkdown(page, "2026.07.02_автореферат.md");

  const layout = () =>
    page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      columns: getComputedStyle(document.querySelector(".workspace")).gridTemplateColumns.split(" ").length,
      toc: getComputedStyle(document.querySelector("#toc-bar")).display !== "none",
      documentVisible: !document.querySelector("#document-body").hidden,
      // Имя статьи должно читаться на месте: иначе за ним придётся лезть в
      // раскрытый список — так и случилось, когда в шапку добавили две кнопки.
      documentNameWidth: document.querySelector("#document-select").getBoundingClientRect().width,
      documentNameTitle: document.querySelector("#document-select").title,
    }));

  // Настольная ширина: документ, рецензия и оглавление рядом.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await layout()).columns).toBe(5);
  expect((await layout()).toc).toBe(true);
  expect((await layout()).overflow).toBe(false);
  // Порог выше собственного минимума поля: он проверяет, что место под имя
  // даёт сам контейнер, а не то, что поле упёрлось в min-width и продавило
  // соседние кнопки.
  expect((await layout()).documentNameWidth).toBeGreaterThanOrEqual(240);
  expect((await layout()).documentNameTitle).toBe("2026.07.02_автореферат.md · 9 стр.");

  // Планшет в альбомной ориентации: оглавление уходит, две панели остаются.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(async () => (await layout()).toc).toBe(false);
  expect((await layout()).columns).toBe(3);
  expect((await layout()).overflow).toBe(false);
  expect((await layout()).documentNameWidth).toBeGreaterThanOrEqual(180);

  // Планшет в книжной ориентации: одна колонка, документ по-прежнему виден.
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect.poll(async () => (await layout()).columns).toBe(1);
  expect((await layout()).overflow).toBe(false);
  expect((await layout()).documentVisible).toBe(true);
  await expect(page.locator("#document-select")).toContainText("2026.07.02_автореферат.md");
});

test("resizes panes by pointer and keyboard and remembers the widths", async ({ page }) => {
  await page.goto("/");
  const paneWidths = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        review: parseFloat(style.getPropertyValue("--review-width")),
        toc: parseFloat(style.getPropertyValue("--toc-width")),
      };
    });

  const initial = await paneWidths();
  const reviewHandle = page.locator('.pane-resizer[data-resize="review"]');
  await reviewHandle.focus();
  await reviewHandle.press("ArrowRight");
  await reviewHandle.press("Shift+ArrowRight");
  const afterKeyboard = await paneWidths();
  expect(afterKeyboard.review).toBe(initial.review + 52);
  await expect(reviewHandle).toHaveAttribute("aria-valuenow", String(afterKeyboard.review));

  const tocHandle = page.locator('.pane-resizer[data-resize="toc"]');
  const box = await tocHandle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const afterDrag = await paneWidths();
  expect(afterDrag.toc).toBeGreaterThan(initial.toc + 40);

  await page.reload();
  const afterReload = await paneWidths();
  expect(afterReload).toEqual(afterDrag);

  await tocHandle.dblclick();
  await expect
    .poll(async () => (await paneWidths()).toc)
    .toBe(initial.toc);

  // Узкое окно переключает медиазапрос: заявленное значение обязано догнать раскладку.
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect
    .poll(async () => tocHandle.getAttribute("aria-valuenow"))
    .toBe(String((await paneWidths()).toc));
});

const nested = `# Заголовок

Обычный абзац для отсчёта.

> Первая строка цитаты.
> Вторая строка цитаты.

- Пункт списка первый
- Пункт списка второй

> Внешняя цитата.
>
> > Вложенная цитата.

\`\`\`js
const a = 1;
\`\`\`

---

Последний абзац.
`;

test("keeps every line number in one gutter column, clear of quote bars and markers", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page, "nested.md", nested);

  const gutter = () =>
    page.evaluate(() => {
      const body = document.querySelector("#document-body");
      // Номер позиционируется от ближайшего позиционированного предка — его и
      // ищем, а не подставляем ожидаемый. Иначе замер проверял бы собственную
      // формулу, а не то, где номер оказался на самом деле.
      const box = (span) => {
        const style = getComputedStyle(span, "::before");
        let anchor = span;
        while (anchor && anchor !== body && getComputedStyle(anchor).position === "static") {
          anchor = anchor.parentElement;
        }
        const base = (anchor ?? body).getBoundingClientRect();
        const left = base.left + parseFloat(style.left);
        return { left, right: left + parseFloat(style.width) };
      };
      // Меряем все строки-ориентиры, а не отобранные образцы: выборка по типам
      // блоков однажды уже пропустила случай — строку с горизонтальной линией,
      // где номер уезжал за пределы колонки.
      const origins = [...body.querySelectorAll(".source-line.line-origin")];
      const lefts = origins.map((span) => box(span).left);

      // Пересечение номера с вертикальной полосой цитаты — тот самый дефект.
      let overlaps = 0;
      for (const quote of body.querySelectorAll("blockquote")) {
        const rect = quote.getBoundingClientRect();
        const barRight = rect.left + parseFloat(getComputedStyle(quote).borderLeftWidth);
        for (const span of quote.querySelectorAll(".source-line.line-origin")) {
          const { left, right } = box(span);
          if (left < barRight && right > rect.left) overlaps += 1;
        }
      }

      // Номер, уехавший за край прокручиваемого предка, был бы обрезан и невидим.
      let clipped = 0;
      for (const span of body.querySelectorAll(".source-line.line-origin")) {
        const { left, right } = box(span);
        for (let node = span.parentElement; node && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.overflowX === "visible" && style.overflowY === "visible") continue;
          const rect = node.getBoundingClientRect();
          if (left < rect.left - 0.5 || right > rect.right + 0.5) clipped += 1;
        }
      }

      return {
        spread: Math.max(...lefts) - Math.min(...lefts),
        overlaps,
        clipped,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

  for (const width of [1440, 1180, 1040, 860]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await gutter()).spread).toBeLessThanOrEqual(1);
    const measured = await gutter();
    expect(measured.overlaps, `ширина ${width}`).toBe(0);
    expect(measured.clipped, `ширина ${width}`).toBe(0);
    expect(measured.overflow, `ширина ${width}`).toBe(false);
  }
});

test("adds a wordless anchored note but never a wordless general one", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);

  await quoteWholeLine(page, 3, "Вопрос");
  await expect(page.locator("#draft-comment")).toBeVisible();
  // Ни подписи «по желанию», ни надписи об ошибке в форме больше нет.
  await expect(page.locator(".draft-card")).not.toContainText("по желанию");
  await expect(page.locator(".draft-card")).not.toContainText("Напишите комментарий");
  await page.locator('[data-action="commit-draft"]').click();

  await expect(page.locator(".review-card")).toHaveCount(1);
  await expect(page.locator(".review-card .card-comment")).toHaveCount(0);
  await expect(page.locator("#review-count")).toHaveText("1 замечание");

  await page.locator("#preview-review").click();
  await expect(page.locator("#preview-content")).toContainText("### Строка 3 · Вопрос");
  await page.locator("#close-preview").click();

  // Общее замечание состоит из одного текста: пустым его добавить нельзя.
  await page.locator("#add-general").click();
  const commit = page.locator('[data-action="commit-draft"]');
  await expect(commit).toBeDisabled();
  await page.locator("#draft-comment").fill("Общий итог.");
  await expect(commit).toBeEnabled();
  await page.locator("#draft-comment").fill("   ");
  await expect(commit).toBeDisabled();
});

test("opens pasted text from the clipboard, by hand and reports an empty buffer", async ({ page }) => {
  const pasted = "---\ntitle: Статья из буфера\n---\n\n# Заголовок вставки\n\nПервый абзац.\n";

  await page.addInitScript(() => {
    window.__clipboard = { mode: "reject", text: "" };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: () =>
          window.__clipboard.mode === "reject"
            ? Promise.reject(new DOMException("denied", "NotAllowedError"))
            : Promise.resolve(window.__clipboard.text),
        writeText: (value) => Promise.resolve(value),
      },
    });
  });
  await page.goto("/");

  // Буфер прочитан: документ открывается сразу, окно не нужно.
  await page.evaluate((text) => {
    window.__clipboard = { mode: "resolve", text };
  }, pasted);
  await page.locator("#paste-text").click();
  await expect(page.locator("#document-select")).toContainText("Статья из буфера");
  await expect(page.locator("#document-body")).toContainText("Первый абзац.");
  await expect(page.locator("#paste-dialog")).not.toBeVisible();

  // В буфере нет текста: человеку сообщают об этом, окно не открывается.
  await page.evaluate(() => {
    window.__clipboard = { mode: "resolve", text: "   " };
  });
  await page.locator("#paste-text").click();
  await expect(page.locator("#toast")).toHaveText("Нет текста в буфере.");
  await expect(page.locator("#paste-dialog")).not.toBeVisible();

  // Браузер не дал прочитать буфер: остаётся ручная вставка.
  await page.evaluate(() => {
    window.__clipboard = { mode: "reject", text: "" };
  });
  await page.locator("#paste-text").click();
  await expect(page.locator("#paste-dialog")).toBeVisible();
  await page.locator("#paste-input").fill("Текст без заголовка и вводной части.\n");
  await page.locator("#submit-paste").click();
  await expect(page.locator("#paste-dialog")).not.toBeVisible();
  // Ни заголовка, ни поля title — остаётся честное общее имя.
  await expect(page.locator("#document-select")).toContainText("Вставленный текст");
  await expect(page.locator("#document-body")).toContainText("Текст без заголовка");
});

test("renames the article without loosening its grip on the review", async ({ page }) => {
  // Без File System Access API «Скачать» уходит обычной загрузкой, и имя файла
  // видно прямо в ней.
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3);
  await commitDraft(page, "Замечание до переименования.");

  await page.locator("#rename-document").click();
  await expect(page.locator("#rename-input")).toHaveValue("article.md");
  // Двоеточие и слэш непригодны для имени файла — их вычищает само приложение.
  await page.locator("#rename-input").fill("Автореферат: ревизия 09/07");
  await page.locator("#submit-rename").click();
  await expect(page.locator("#rename-dialog")).not.toBeVisible();
  await expect(page.locator("#document-select")).toContainText("Автореферат ревизия 09 07");

  await page.locator("#preview-review").click();
  await expect(page.locator("#preview-content")).toContainText('"name":"Автореферат ревизия 09 07"');
  await page.locator("#close-preview").click();

  const download = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#save-review").click(),
  ]).then(([event]) => event);
  expect(download.suggestedFilename()).toBe("Автореферат ревизия 09 07.review.md");

  // Рецензия висит на идентификаторе документа, поэтому имя её не задевает.
  await page.reload();
  await expect(page.locator("#document-select")).toContainText("Автореферат ревизия 09 07");
  await expect(page.locator(".review-card")).toContainText("Замечание до переименования.");
});

test("refuses an empty name and an empty paste in a way the reader can see", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
        writeText: (value) => Promise.resolve(value),
      },
    });
  });
  await page.goto("/");
  await loadMarkdown(page);

  // Пустое поле в окне ручной вставки: буфер здесь ни при чём, и сообщение
  // говорит про поле, а не про него.
  await page.locator("#paste-text").click();
  await expect(page.locator("#paste-dialog")).toBeVisible();
  await page.locator("#submit-paste").click();
  await expect(page.locator("#toast")).toHaveText("Поле пустое: вставьте текст статьи.");
  await expect(page.locator("#paste-dialog")).toBeVisible();
  // Escape закрывает окно, и оно открывается снова чистым.
  await page.keyboard.press("Escape");
  await expect(page.locator("#paste-dialog")).not.toBeVisible();
  await page.locator("#paste-text").click();
  await expect(page.locator("#paste-input")).toHaveValue("");
  await page.locator("#cancel-paste").click();

  // Имя, которое после очистки пусто, сохранить нельзя — и это видно по кнопке.
  await page.locator("#rename-document").click();
  const save = page.locator("#submit-rename");
  await expect(save).toBeEnabled();
  await page.locator("#rename-input").fill("   ");
  await expect(save).toBeDisabled();
  await page.locator("#rename-input").fill("///");
  await expect(save).toBeDisabled();
  await page.locator("#rename-input").fill("Новое имя");
  await expect(save).toBeEnabled();

  // Enter в поле имени равнозначен кнопке «Сохранить».
  await page.locator("#rename-input").press("Enter");
  await expect(page.locator("#rename-dialog")).not.toBeVisible();
  await expect(page.locator("#document-select")).toContainText("Новое имя");

  await page.locator("#rename-document").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#rename-dialog")).not.toBeVisible();
  await expect(page.locator("#document-select")).toContainText("Новое имя");
});

// Документ собирается частями, и вопрос не в скорости, а в том, получается ли
// ровно та же страница. Проверяем не образцы, а всю разметку целиком: сборка
// по блокам и сборка одним куском должны совпасть символ в символ.
test("builds the document in pieces without changing a single node", async ({ page }) => {
  await page.goto("/");
  const comparison = await page.evaluate(async () => {
    const markdown = await import("/src/markdown.js");
    const { buildArticle } = await import("/tests/perf/article.js");
    const text = buildArticle(3000);

    const whole = document.createElement("div");
    whole.append(markdown.renderMarkdown(text));

    const inPieces = document.createElement("div");
    const plan = markdown.planMarkdown(text);
    for (const range of plan.ranges) inPieces.append(markdown.renderTokenRange(plan, range));

    return {
      identical: whole.innerHTML === inPieces.innerHTML,
      pieces: plan.ranges.length,
      lines: inPieces.querySelectorAll(".source-line.line-origin").length,
      firstDifference: (() => {
        const left = whole.innerHTML;
        const right = inPieces.innerHTML;
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
          if (left[index] !== right[index]) return left.slice(Math.max(0, index - 60), index + 60);
        }
        return null;
      })(),
    };
  });

  expect(comparison.firstDifference).toBeNull();
  expect(comparison.identical).toBe(true);
  expect(comparison.pieces).toBeGreaterThan(100);
  expect(comparison.lines).toBeGreaterThan(1000);
});

// Документ выкладывается группами, и граница между ними не должна быть заметна
// человеку: выделение, начатое в одной группе и законченное в другой, обязано
// давать такую же цитату, как внутри одной.
test("quotes a selection that runs across a group boundary", async ({ page }) => {
  await page.goto("/");
  const text = [
    "# Проверка границ",
    "",
    ...Array.from({ length: 400 }, (_, index) => `Абзац номер ${index + 1} со своим содержанием.\n`),
  ].join("\n");
  await loadMarkdown(page, "boundary.md", text);
  await expect(page.locator("#document-body")).toHaveAttribute("data-rendered", "complete");

  const groups = await page.locator(".document-chunk").count();
  expect(groups).toBeGreaterThan(1);

  // Берём последнюю строку одной группы и первую строку следующей.
  const pair = await page.evaluate(() => {
    const chunks = [...document.querySelectorAll(".document-chunk")];
    for (let index = 0; index < chunks.length - 1; index += 1) {
      const before = [...chunks[index].querySelectorAll(".source-line.line-origin")].at(-1);
      const after = chunks[index + 1].querySelector(".source-line.line-origin");
      if (before && after) {
        return { from: Number(before.dataset.sourceLine), to: Number(after.dataset.sourceLine) };
      }
    }
    return null;
  });
  expect(pair).not.toBeNull();

  await page.evaluate(({ from, to }) => {
    const start = document.querySelector(`.source-line[data-source-line="${from}"]`);
    const end = document.querySelector(`.source-line[data-source-line="${to}"]`);
    const range = document.createRange();
    range.setStart(start.firstChild, 0);
    range.setEnd(end.firstChild, end.firstChild.textContent.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector("#document-body").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, pair);

  await expect(page.locator("#quote-toolbar")).toBeVisible();
  await page.locator('#quote-toolbar [data-quote-type="Вопрос"]').click();
  await commitDraft(page, "Через границу.");
  await expect(page.locator(".review-card blockquote")).toContainText(`Абзац номер`);
  await expect(page.locator(".review-card .line-link")).toHaveText(`строки ${pair.from}–${pair.to}`);
});

// Рецензию присылают: письмом, вместе со статьёй, из чужой папки. Машинный блок
// в её конце — обычный JSON, и приложение когда-то верило ему на слово: поле с
// номером строки уходило в разметку карточки как есть, а разметка исполнялась.
// Проверка держит оба рубежа сразу — форму записи и экранирование вывода.
function reviewFileWith(entry) {
  const payload = {
    document: { name: "Заголовок", sha256: null },
    // Запись заполнена целиком: иначе неисправленный код спотыкается о пустое
    // поле, проверка краснеет по чужой причине и ничего не доказывает.
    entries: [
      {
        kind: "anchored",
        status: "committed",
        quote: "Первая строка с целью.",
        comment: "обычное замечание",
        replacement: "",
        startColumn: 0,
        endColumn: 20,
        sequence: 1,
        ...entry,
      },
    ],
  };
  return [
    "### Строка 3 · Правка",
    "",
    "> Первая строка с целью.",
    "",
    "обычное замечание",
    "",
    `<!-- marginalia:1 ${JSON.stringify(payload)} -->`,
    "",
  ].join("\n");
}

test("refuses to run code hidden in an imported review", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);

  const attacks = [
    { field: "startLine", entry: { type: "Правка", startLine: '3<img src=x onerror="window.__owned=true">', endLine: 3 } },
    { field: "endLine", entry: { type: "Правка", startLine: 3, endLine: '4<img src=x onerror="window.__owned=true">' } },
    { field: "type", entry: { type: '<img src=x onerror="window.__owned=true">', startLine: 3, endLine: 3 } },
    { field: "id", entry: { type: "Правка", startLine: 3, endLine: 3, id: '" onmouseover="window.__owned=true' } },
  ];

  for (const attack of attacks) {
    await page.locator("#review-input").setInputFiles({
      name: `${attack.field}.md`,
      mimeType: "text/markdown",
      buffer: Buffer.from(reviewFileWith(attack.entry)),
    });
    await expect(page.locator(".review-card")).toHaveCount(1);
    // Ни исполнения, ни узла, который его нёс: карточка осталась текстом.
    expect(await page.evaluate(() => window.__owned ?? null), attack.field).toBeNull();
    await expect(page.locator("#review-list img, #review-list script")).toHaveCount(0);
    await expect(page.locator(".review-card .type-badge")).toHaveText("Правка");
  }

  // Заражение переживало перезагрузку: запись ложилась в хранилище и исполнялась
  // при каждом открытии. Форма проверяется и на чтении, поэтому не переживает.
  await page.reload();
  await expect(page.locator(".review-card")).toHaveCount(1);
  expect(await page.evaluate(() => window.__owned ?? null)).toBeNull();
  await expect(page.locator("#review-list img, #review-list script")).toHaveCount(0);
});

test("still opens a review exported by an earlier version", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3, "Вопрос");
  await commitDraft(page, "Замечание для выгрузки.", "");
  await expect(page.locator(".review-card")).toHaveCount(1);

  const exported = await page.evaluate(() => {
    const dialog = document.querySelector("#preview-content");
    document.querySelector("#preview-review").click();
    const text = dialog.textContent;
    document.querySelector("#close-preview").click();
    return text;
  });
  expect(exported).toContain("<!-- marginalia:1");

  // Тот же файл узнаётся по SHA-256 и возвращает прежнюю рецензию, поэтому для
  // чистого листа нужен другой текст — но с той же строкой, к которой привязка.
  await loadMarkdown(page, "clean.md", article.replace("# Заголовок", "# Другой заголовок"));
  await expect(page.locator(".review-card")).toHaveCount(0);
  await page.locator("#review-input").setInputFiles({
    name: "review.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(exported),
  });
  await expect(page.locator(".review-card")).toHaveCount(1);
  await expect(page.locator(".review-card .card-comment")).toHaveText("Замечание для выгрузки.");
  await expect(page.locator(".review-card .line-link")).toHaveText("строка 3");
});
