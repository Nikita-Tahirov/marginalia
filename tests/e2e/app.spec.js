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
  await loadMarkdown(page);

  const layout = () =>
    page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      columns: getComputedStyle(document.querySelector(".workspace")).gridTemplateColumns.split(" ").length,
      toc: getComputedStyle(document.querySelector("#toc-bar")).display !== "none",
      documentVisible: !document.querySelector("#document-body").hidden,
    }));

  // Настольная ширина: документ, рецензия и оглавление рядом.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await layout()).columns).toBe(5);
  expect((await layout()).toc).toBe(true);
  expect((await layout()).overflow).toBe(false);

  // Планшет в альбомной ориентации: оглавление уходит, две панели остаются.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(async () => (await layout()).toc).toBe(false);
  expect((await layout()).columns).toBe(3);
  expect((await layout()).overflow).toBe(false);

  // Планшет в книжной ориентации: одна колонка, документ по-прежнему виден.
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect.poll(async () => (await layout()).columns).toBe(1);
  expect((await layout()).overflow).toBe(false);
  expect((await layout()).documentVisible).toBe(true);
  await expect(page.locator("#document-select")).toContainText("article.md");
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
