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
});
