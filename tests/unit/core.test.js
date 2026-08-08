import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  anchoredSortKey,
  boundaryAfter,
  nextFreeOrder,
  orderReviewEntries,
  serializeReview,
  splitPhysicalLines,
} from "../../src/core.js";

function anchored(id, startLine, startColumn, endLine, endColumn, sequence) {
  return {
    id,
    kind: "anchored",
    status: "committed",
    type: "Правка",
    quote: id,
    comment: `Комментарий ${id}`,
    replacement: "",
    startLine,
    startColumn,
    endLine,
    endColumn,
    sequence,
  };
}

function free(id, boundaryKey, freeOrder, sequence) {
  return {
    id,
    kind: "free",
    status: "committed",
    comment: `Общее ${id}`,
    boundaryKey,
    freeOrder,
    sequence,
  };
}

test("splitPhysicalLines preserves LF, CRLF, CR and a trailing empty physical line", () => {
  assert.deepEqual(splitPhysicalLines("a\nb\n"), {
    lines: ["a", "b", ""], starts: [0, 2, 4], endings: ["\n", "\n", ""],
  });
  assert.deepEqual(splitPhysicalLines("a\r\nb\rc"), {
    lines: ["a", "b", "c"], starts: [0, 3, 5], endings: ["\r\n", "\r", ""],
  });
  assert.deepEqual(splitPhysicalLines(""), { lines: [""], starts: [0], endings: [""] });
});

test("the supplied sample has 283 physical lines without normalizing its bytes", async () => {
  const path = new URL("../../uploads/autoref_file-1786119922332-a407.md", import.meta.url);
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  assert.equal(splitPhysicalLines(text).lines.length, 283);
  assert.deepEqual(Buffer.from(text, "utf8"), bytes);
});

test("anchored entries sort by start line, start column, end and creation sequence", () => {
  const entries = [
    anchored("later-line", 9, 0, 9, 2, 1),
    anchored("later-column", 4, 7, 4, 9, 2),
    anchored("longer", 4, 2, 5, 1, 3),
    anchored("shorter", 4, 2, 4, 6, 4),
    anchored("same-created-later", 4, 2, 4, 6, 8),
  ];
  assert.deepEqual(orderReviewEntries(entries).map((entry) => entry.id), [
    "shorter", "same-created-later", "longer", "later-column", "later-line",
  ]);
});

test("free notes keep their saved coordinate gap when anchored notes are added or removed", () => {
  const a = anchored("a", 10, 2, 10, 5, 1);
  const b = anchored("b", 20, 1, 20, 4, 2);
  const note1 = free("note-1", boundaryAfter(a), 1, 3);
  const note2 = free("note-2", boundaryAfter(a), nextFreeOrder([note1], boundaryAfter(a), note1), 4);
  assert.deepEqual(orderReviewEntries([b, note2, a, note1]).map((entry) => entry.id), [
    "a", "note-1", "note-2", "b",
  ]);

  const insertedBefore = anchored("before", 5, 0, 5, 1, 5);
  const insertedLater = anchored("middle", 15, 0, 15, 1, 6);
  assert.deepEqual(
    orderReviewEntries([insertedLater, note2, b, note1, insertedBefore]).map((entry) => entry.id),
    ["before", "note-1", "note-2", "middle", "b"],
  );
});

test("ordering stays deterministic through more than one hundred insertions", () => {
  const anchor = anchored("anchor", 50, 0, 50, 4, 1);
  const note = free("persistent", anchoredSortKey(anchor), 1, 2);
  const entries = [note];
  for (let index = 0; index < 150; index += 1) {
    entries.push(anchored(`a-${index}`, index + 1, index % 3, index + 1, index % 3 + 1, index + 3));
  }
  const expected = orderReviewEntries(entries).map((entry) => entry.id);
  for (let pass = 0; pass < 20; pass += 1) {
    const rotated = entries.slice(pass).concat(entries.slice(0, pass));
    assert.deepEqual(orderReviewEntries(rotated).map((entry) => entry.id), expected);
  }
  assert.equal(expected.indexOf("persistent"), expected.indexOf("a-49") - 1);
});

test("export uses readable singular/range headings, quotes, replacement and free notes", () => {
  const first = {
    ...anchored("q", 47, 3, 50, 8, 1), type: "Вопрос",
    quote: "первая строка\nвторая строка", comment: "Нужен источник.",
    replacement: "Новая первая\nНовая вторая",
  };
  const second = { ...anchored("d", 52, 0, 52, 4, 2), type: "Удалить", replacement: "" };
  const general = free("g", boundaryAfter(second), 1, 3);
  general.comment = "Общий итог.";
  assert.equal(
    serializeReview([general, second, first]),
    "### Строки 47–50 · Вопрос\n\n> первая строка\n> вторая строка\n\nНужен источник.\n\n**Заменить на:** Новая первая\nНовая вторая\n\n### Строка 52 · Удалить\n\n> d\n\nКомментарий d\n\n### Общее замечание\n\nОбщий итог.\n",
  );
});
