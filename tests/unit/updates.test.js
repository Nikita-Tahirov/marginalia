import assert from "node:assert/strict";
import test from "node:test";

import { safeToApply } from "../../src/updates.js";

const waiting = { postMessage() {} };

test("применяет обновление, когда вкладка скрыта и человек ничего не пишет", () => {
  assert.equal(safeToApply({ waiting, busy: false, hidden: true }), true);
});

test("не применяет, пока открыт черновик или форма правки", () => {
  // Даже на скрытой вкладке: набранный, но не сохранённый текст живёт в поле,
  // и перезагрузка унесла бы его вместе со страницей.
  assert.equal(safeToApply({ waiting, busy: true, hidden: true }), false);
});

test("не применяет, пока человек смотрит на вкладку", () => {
  // Перезагрузка на глазах — это и есть подмена кода под руками, ради которой
  // сборка держит registerType: "prompt".
  assert.equal(safeToApply({ waiting, busy: false, hidden: false }), false);
  assert.equal(safeToApply({ waiting, busy: true, hidden: false }), false);
});

test("ничего не делает, когда применять нечего", () => {
  assert.equal(safeToApply({ waiting: null, busy: false, hidden: true }), false);
  assert.equal(safeToApply({ waiting: undefined, busy: false, hidden: true }), false);
});
