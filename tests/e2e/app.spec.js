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
async function selectPartOfLine(page, line, from, to) {
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
}

async function quotePartOfLine(page, line, from, to, type = "Правка") {
  await selectPartOfLine(page, line, from, to);
  await page.locator(`#quote-toolbar [data-quote-type="${type}"]`).click();
}

// Цитаты красятся по типу замечания, поэтому наборов подсветки восемь: четыре
// типа в двух состояниях. Проверяем состояние целиком — какой именно тип красит
// цитату, спрашиваем отдельно.
async function highlightedFragments(page, state) {
  return page.evaluate((prefix) => {
    const found = [];
    for (const [name, highlight] of CSS.highlights) {
      if (!name.startsWith(prefix)) continue;
      found.push(...[...highlight].map((range) => range.toString()));
    }
    return found;
  }, `marginalia-${state}-`);
}

// Читаем не экран, а само хранилище: сообщение о записи живёт четыре секунды и
// от прошлого действия неотличимо, а перезагрузка сразу за ним обгоняла бы
// незавершённую запись и краснела по своей же причине.
async function storedComments(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("marginalia", 1);
        request.onsuccess = () => {
          const rows = request.result.transaction("reviews", "readonly").objectStore("reviews").getAll();
          rows.onsuccess = () =>
            resolve(rows.result.flatMap((row) => row.entries.map((entry) => entry.comment)));
        };
        request.onerror = () => resolve([]);
      }),
  );
}

// Привязанное замечание существует с того мгновения, как назван его тип, и
// сразу открыто для письма: подтверждать нечего. Общее замечание без текста
// пусто целиком — его добавляют кнопкой.
async function commitDraft(page, comment, replacement = "") {
  if (await page.locator("#edit-comment").count()) {
    await page.locator("#edit-comment").fill(comment);
    if (replacement) await page.locator("#edit-replacement").fill(replacement);
    await page.locator("#edit-comment").press("Control+Enter");
    return;
  }
  await page.locator("#draft-comment").fill(comment);
  if (replacement) await page.locator("#draft-replacement").fill(replacement);
  await page.locator('[data-action="commit-draft"]').click();
}

test("loads documents, searches and keeps per-document reviews", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await expect(page.locator("#document-lines")).toHaveText("9 строк");
  await expect(page.locator("#document-notes")).toHaveText("0 замечаний");
  await expect(page.locator("#toc-list")).toContainText("Заголовок");
  await expect(page.locator("#toc-list")).toContainText("Раздел");

  await page.locator("#search-input").fill("цель");
  await expect(page.locator("#search-counter")).toHaveText("1 / 3");
  await page.locator("#search-next").click();
  await expect(page.locator("#search-counter")).toHaveText("2 / 3");

  await quoteWholeLine(page, 3, "Правка");
  await commitDraft(page, "Уточнить формулировку.", "Исправленная строка.");
  await expect(page.locator(".review-card")).toHaveCount(1);
  await expect(page.locator("#document-notes")).toHaveText("1 замечание");

  await loadMarkdown(page, "second.md", "# Второй\n\nТекст.\n");
  await expect(page.locator(".review-card")).toHaveCount(0);
  await page.locator("#document-select").selectOption({ label: "article.md" });
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
  await expect(page.locator(".review-card")).toHaveCount(4);

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

// Замечание пишут по ходу чтения и перечитывают потом: формулировка выходит
// резкой, тип неточным, замена с опечаткой. Раньше запись оставалось только
// удалить и написать заново, потеряв и цитату, и место в рецензии.
test("edits an added note in place and keeps the edit after a reload", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3, "Правка");
  await commitDraft(page, "Первая формулировка.", "Первая замена.");
  await expect(page.locator(".review-card .type-badge")).toHaveText("Правка");

  // Правят по самому тексту: кнопка «Изменить» для этого больше не нужна.
  await page.locator(".review-card .card-comment").click();
  // Цитата и строка — якорь записи, а не её содержание: их форма правки не даёт.
  await expect(page.locator(".edit-card blockquote")).toContainText("Первая строка с целью.");
  await expect(page.locator(".edit-card")).toContainText("строка 3");
  await expect(page.locator("#edit-comment")).toBeFocused();
  await expect(page.locator("#edit-comment")).toHaveValue("Первая формулировка.");
  await expect(page.locator("#edit-replacement")).toHaveValue("Первая замена.");

  // Написанное сохраняется само: подтверждать нечего, и уход из формы уносит
  // не черновик, а готовую запись.
  await page.locator("#edit-comment").fill("Уточнённая формулировка.");
  await page.locator("#edit-replacement").fill("Уточнённая замена.");
  await page.locator('.edit-card [data-action="edit-type"][data-type="Вопрос"]').click();
  await expect(page.locator("#edit-comment")).toHaveValue("Уточнённая формулировка.");
  await page.locator("#edit-comment").press("Escape");

  await expect(page.locator(".review-card .card-comment")).toHaveText("Уточнённая формулировка.");
  await expect(page.locator(".review-card .replacement p")).toHaveText("Уточнённая замена.");
  await expect(page.locator(".review-card .type-badge")).toHaveText("Вопрос");
  await expect(page.locator(".review-card .line-link")).toHaveText("строка 3");
  await expect(page.locator("#toast")).toHaveText("Замечание сохранено.");

  // Правка живёт в хранилище, а не только на экране.
  await expect.poll(() => storedComments(page)).toEqual(["Уточнённая формулировка."]);
  await page.reload();
  await expect(page.locator(".review-card .card-comment")).toHaveText("Уточнённая формулировка.");
  await expect(page.locator(".review-card .type-badge")).toHaveText("Вопрос");
  await expect(page.locator(".review-card .replacement p")).toHaveText("Уточнённая замена.");

  await page.locator("#preview-review").click();
  await expect(page.locator("#preview-content")).toContainText("### Строка 3 · Вопрос");
  await expect(page.locator("#preview-content")).toContainText("Уточнённая формулировка.");
  await page.locator("#close-preview").click();

  // Клик по замене открывает её же поле, а не комментарий.
  await page.locator(".review-card .replacement").click();
  await expect(page.locator("#edit-replacement")).toBeFocused();
  await page.locator("#edit-replacement").fill("Замена, переписанная на месте.");
  await page.locator("#edit-replacement").press("Escape");
  await expect(page.locator(".review-card .replacement p")).toHaveText(
    "Замена, переписанная на месте.",
  );

  // Общее замечание состоит из одного текста: опустевшим его не сохранить.
  await page.locator("#add-general").click();
  await commitDraft(page, "Общий вывод.");
  await page.locator(".free-card .card-comment").click();
  await page.locator("#edit-comment").fill("   ");
  await page.locator("#edit-comment").press("Control+Enter");
  // Опустевшее общее замечание не записывается: иначе человек стёр бы запись,
  // не нажав «Удалить».
  await expect(page.locator(".free-card .card-comment")).toHaveText("Общий вывод.");
  await page.locator(".free-card .card-comment").click();
  await page.locator("#edit-comment").fill("Общий вывод, переписанный набело.");
  await page.locator("#edit-comment").press("Control+Enter");
  await expect(page.locator(".free-card .card-comment")).toHaveText(
    "Общий вывод, переписанный набело.",
  );
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
  await page.locator("#edit-comment").fill("Клавиатурное замечание.");
  await page.locator("#edit-comment").press("Control+Enter");
  await expect(page.locator(".review-card")).toContainText("Клавиатурное замечание.");

  await page.locator(".review-card blockquote").click();
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
  // Панель называет только сами действия: подпись над ними человека сбивала —
  // её принимали за пятую кнопку.
  await expect(page.locator("#quote-toolbar")).not.toContainText("Цитировать");
  await expect(page.locator("#quote-toolbar > *")).toHaveCount(4);
  await firstType.click();
  await commitDraft(page, "Замечание из глубины документа.");
  await expect(page.locator(".review-card")).toContainText("строка 37");

  await page.locator("#document-pane").evaluate((element) => element.scrollTo({ top: 0 }));
  await page.locator(".review-card blockquote").click();
  await expect(source).toHaveClass(/is-active-annotation/);
  await expect(source).toBeInViewport();

  // Строка Markdown — целый абзац, и тень с растеканием обводила его инлайновый
  // бокс: над текстом и под ним появлялась линия во всю ширину колонки. Пометка
  // остаётся внутри строки, поэтому наружной тени у неё быть не должно.
  const shadow = await source.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(shadow.split(/,(?![^(]*\))/).every((layer) => layer.includes("inset"))).toBe(true);
});

// Панель предлагает действие над выделением: пережив его, она закрывает текст
// и обещает то, чего уже нет.
test("hides the quote toolbar whenever the selection is dropped", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);

  const toolbar = page.locator("#quote-toolbar");
  const source = page.locator('.source-line.line-origin[data-source-line="3"]');

  await source.focus();
  await source.press("Enter");
  await expect(toolbar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeHidden();
  // Панель открыта вслепую, с клавиатуры: фокус обязан вернуться на ту же
  // строку, иначе человек окажется в начале документа.
  await expect(source).toBeFocused();

  await selectPartOfLine(page, 3, 0, 6);
  await page.locator("#search-input").click();
  await expect(toolbar).toBeHidden();

  await selectPartOfLine(page, 3, 0, 6);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await expect(toolbar).toBeHidden();
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
  expect(await highlightedFragments(page, "active")).toEqual(["строка"]);
  expect(await highlightedFragments(page, "note")).toEqual([]);

  // Границы цитаты переживают перезагрузку вместе с самой записью.
  await expect(page.locator("#toast")).toHaveText("Замечание сохранено.");
  await page.reload();
  await expect(page.locator(".review-card")).toContainText("Замечание к части строки.");
  expect(await highlightedFragments(page, "note")).toEqual(["строка"]);
  expect(await highlightedFragments(page, "active")).toEqual([]);

  await page.locator(".review-card blockquote").click();
  expect(await highlightedFragments(page, "active")).toEqual(["строка"]);
  expect(await highlightedFragments(page, "note")).toEqual([]);

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
  expect(await highlightedFragments(page, "note")).toEqual([]);
});

test("keeps the review after the browser is closed and reopened", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);
  await quoteWholeLine(page, 3, "Вопрос");
  await commitDraft(page, "Замечание, которое обязано пережить перезагрузку.");
  await expect(page.locator(".review-card")).toHaveCount(1);
  // Одно сообщение об одном событии: и о самом действии, и о его записи.
  await expect(page.locator("#toast")).toHaveText("Замечание сохранено.");
  await expect(page.locator("#save-state")).toBeHidden();

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
  // Работа, которая не переживёт вкладку, названа прямо и не гаснет сама.
  await expect(page.locator("#save-state")).toHaveText("Не сохранено");
  await expect(page.locator("#toast")).toHaveText("Замечание добавлено, но не сохранено.");

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
      // Ищем число строк по всему приложению, а не в заранее известном месте:
      // проверка обязана краснеть на любом втором его упоминании. Считаем самый
      // глубокий узел с такой подписью: число и слово живут в разных узлах,
      // чтобы на узкой шапке слово можно было убрать.
      lineCounts: [...document.querySelectorAll("#app *")]
        .filter((node) => /^\d+\s+(строк|стр)/.test(node.textContent.trim()))
        .filter(
          (node) =>
            ![...node.children].some((child) => /^\d+\s+(строк|стр)/.test(child.textContent.trim())),
        )
        .map((node) => node.textContent.trim()),
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
  expect((await layout()).documentNameTitle).toBe("2026.07.02_автореферат.md");
  // Длина документа названа один раз — рядом с именем, а не ещё и в оглавлении.
  expect((await layout()).lineCounts).toEqual(["9 строк"]);

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

// Панель тянут мышью до 300px, и на этой ширине её верхний ряд однажды
// разъезжался на две строки, съедая место у самой рецензии. Меряем не ширину
// содержимого, а то, на скольких строках оно оказалось.
test("keeps the review toolbar on a single row down to the narrowest pane", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);

  const toolbar = () =>
    page.evaluate(() => {
      const bar = document.querySelector(".review-toolbar");
      const children = [...bar.children].filter((node) => node.getBoundingClientRect().width > 0);
      // Ряд выровнен по центру, поэтому строки различают середины, а не верхние
      // края: у элементов разной высоты они и в одной строке не совпадают.
      const centers = children.map((node) => {
        const rect = node.getBoundingClientRect();
        return Math.round(rect.top + rect.height / 2);
      });
      // Свободное место в ряду: подогнанный впритык ряд разъезжается на другой
      // платформе, где те же надписи набраны на пару пикселей шире.
      const style = getComputedStyle(bar);
      const inner =
        bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const used =
        children.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0) +
        parseFloat(style.columnGap || 0) * Math.max(0, children.length - 1);
      return {
        rows: new Set(centers).size,
        height: Math.round(bar.getBoundingClientRect().height),
        clipped: bar.scrollWidth > bar.clientWidth + 1,
        slack: Math.round(inner - used),
        openReviewVisible:
          document.querySelector("#open-review").getBoundingClientRect().width > 0,
      };
    });

  for (const width of [760, 520, 360, 300]) {
    await page.evaluate((value) => {
      document.documentElement.style.setProperty("--review-width", `${value}px`);
    }, width);
    const measured = await toolbar();
    expect(measured.rows, `ширина ${width}`).toBe(1);
    expect(measured.height, `ширина ${width}`).toBeLessThanOrEqual(48);
    expect(measured.clipped, `ширина ${width}`).toBe(false);
    expect(measured.slack, `ширина ${width}`).toBeGreaterThanOrEqual(12);
    // Действие не исчезает вместе с подписью: сжимается только сама подпись.
    expect(measured.openReviewVisible, `ширина ${width}`).toBe(true);
  }
});

test("hides and restores the contents pane and remembers the choice", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);

  const columns = () =>
    page.evaluate(
      () => getComputedStyle(document.querySelector(".workspace")).gridTemplateColumns.split(" ").length,
    );

  await expect(page.locator("#toc-bar")).toBeVisible();
  expect(await columns()).toBe(5);

  await page.locator("#toggle-toc").click();
  await expect(page.locator("#toc-bar")).toBeHidden();
  await expect(page.locator('.pane-resizer[data-resize="toc"]')).toBeHidden();
  await expect(page.locator("#toggle-toc")).toHaveAttribute("aria-pressed", "false");
  expect(await columns()).toBe(3);

  // Раскладка, выбранная руками, переживает перезагрузку — как и ширина панелей.
  await page.reload();
  await expect(page.locator("#toc-bar")).toBeHidden();
  expect(await columns()).toBe(3);

  await page.locator("#toggle-toc").click();
  await expect(page.locator("#toc-bar")).toBeVisible();
  await expect(page.locator("#toc-list")).toContainText("Заголовок");
  expect(await columns()).toBe(5);
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
  // Запись существует с того мгновения, как назван тип: подтверждать нечего,
  // и поле открыто сразу.
  await expect(page.locator("#edit-comment")).toBeFocused();
  await expect(page.locator(".edit-card")).not.toContainText("Добавить");
  await expect(page.locator(".edit-card")).not.toContainText("Отмена");
  await page.locator("#edit-comment").press("Escape");

  await expect(page.locator(".review-card")).toHaveCount(1);
  await expect(page.locator("#document-notes")).toHaveText("1 замечание");
  // Бессловесное замечание остаётся бессловесным: пустой комментарий — это
  // приглашение дописать, а не текст записи.
  await expect(page.locator(".review-card .card-comment")).toHaveClass(/is-empty/);

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

test("keeps the replacement field out of the card until it is written", async ({ page }) => {
  await page.goto("/");
  await loadMarkdown(page);

  // «Правка» — тот тип, который прежде показывал пустую рамку замены.
  await quoteWholeLine(page, 3, "Правка");
  await page.locator("#edit-comment").fill("Формулировка тяжеловата.");
  await page.locator("#edit-comment").press("Escape");

  await expect(page.locator(".review-card .card-comment")).toHaveText("Формулировка тяжеловата.");
  await expect(page.locator(".review-card .replacement")).toHaveCount(0);

  // Дописать замену по-прежнему можно: карандаш открывает то же поле.
  await page.locator(".review-card .card-edit").click();
  await page.locator("#edit-replacement").fill("Более лёгкая формулировка.");
  await page.locator("#edit-replacement").press("Escape");
  await expect(page.locator(".review-card .replacement p")).toHaveText(
    "Более лёгкая формулировка.",
  );

  // Опустевшая замена снова уходит из карточки, а не остаётся пустой рамкой:
  // одни пробелы — это не записанный текст.
  await page.locator(".review-card .replacement").click();
  await page.locator("#edit-replacement").fill("   ");
  await page.locator("#edit-replacement").press("Escape");
  await expect(page.locator(".review-card .replacement")).toHaveCount(0);
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
  // Имя берётся из вводной части, хотя в самом тексте её больше не показывают.
  await expect(page.locator("#document-body")).not.toContainText("title:");
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

// Вводная часть — поля файла, а не текст статьи, и markdown-it читал её
// закрывающие «---» как подчёркивание заголовка: метаданные вставали в текст
// крупным заголовком и первым пунктом оглавления. Убрать их мало — привязка
// замечаний держится на номерах физических строк, и они обязаны устоять.
test("keeps the front matter out of the text without moving a single line", async ({ page }) => {
  const withFrontMatter = [
    "---",
    'title: "Статья с метаданными"',
    "status: черновик",
    "---",
    "",
    "# Настоящий заголовок",
    "",
    "Абзац, к которому пишут замечание.",
    "",
  ].join("\n");

  await page.goto("/");
  await loadMarkdown(page, "meta.md", withFrontMatter);

  await expect(page.locator("#document-body")).not.toContainText("schema_version");
  await expect(page.locator("#document-body")).not.toContainText("status:");
  await expect(page.locator("#document-body")).not.toContainText("title:");
  await expect(page.locator("#toc-list")).toHaveText("Настоящий заголовок");
  // Длина документа считается по файлу целиком: вводная часть в нём есть.
  await expect(page.locator("#document-lines")).toHaveText("9 строк");
  await expect(page.locator("#document-notes")).toHaveText("0 замечаний");

  // Восьмая строка файла осталась восьмой и в разметке, и в замечании.
  await expect(page.locator('.source-line[data-source-line="8"]')).toContainText(
    "Абзац, к которому пишут замечание.",
  );
  await quoteWholeLine(page, 8, "Вопрос");
  await commitDraft(page, "Замечание к строке после метаданных.");
  await expect(page.locator(".review-card .line-link")).toHaveText("строка 8");
  await expect(page.locator(".review-card blockquote")).toContainText("Абзац, к которому пишут");

  await page.locator("#preview-review").click();
  await expect(page.locator("#preview-content")).toContainText("### Строка 8 · Вопрос");
  await page.locator("#close-preview").click();

  // Черта посреди статьи остаётся чертой: вырезается только вводная часть.
  await loadMarkdown(page, "rule.md", "# Заголовок\n\nПервый абзац.\n\n---\n\nВторой абзац.\n");
  await expect(page.locator("#document-body hr")).toHaveCount(1);
  await expect(page.locator("#document-body")).toContainText("Второй абзац.");
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
