import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SCALE, READING_SCALES, normalizeScale, stepScale } from "../../src/reading.js";

test("шкала идёт от 80% до 150% и включает обычный размер", () => {
  assert.equal(READING_SCALES[0], 0.8);
  assert.equal(READING_SCALES.at(-1), 1.5);
  assert.ok(READING_SCALES.includes(DEFAULT_SCALE));
});

test("шаг меняет размер на одну ступень в названную сторону", () => {
  assert.equal(stepScale(1, 1), 1.1);
  assert.equal(stepScale(1, -1), 0.9);
});

test("на краю шкалы шаг оставляет размер прежним", () => {
  assert.equal(stepScale(1.5, 1), 1.5);
  assert.equal(stepScale(0.8, -1), 0.8);
});

// Сохранённое значение приходит строкой, а сложение долей даёт 1.2000000000000002:
// точное сравнение здесь сорвало бы шаг на ровном месте.
test("приводит сохранённое значение к ближайшей ступени", () => {
  assert.equal(normalizeScale("1.2"), 1.2);
  assert.equal(normalizeScale(1.2000000000000002), 1.2);
  assert.equal(normalizeScale(1.23), 1.2);
});

test("непригодное значение читается как обычный размер", () => {
  assert.equal(normalizeScale(null), DEFAULT_SCALE);
  assert.equal(normalizeScale("огромный"), DEFAULT_SCALE);
});

// Хранилище — не доверенный источник: в нём мог остаться размер прежней версии
// приложения или чужая запись. Шкала обязана удержать показ в своих пределах.
test("значение вне шкалы прижимается к её краю", () => {
  assert.equal(normalizeScale(9), 1.5);
  assert.equal(normalizeScale(0.1), 0.8);
});
