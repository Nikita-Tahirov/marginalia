import assert from "node:assert/strict";
import test from "node:test";

import { NBSP, bindShortWords } from "../../src/markdown.js";

// Читать проверки удобнее, когда неразрывный пробел виден: в исходнике теста
// он неотличим от обычного, и расхождение пришлось бы искать глазами.
function visible(text) {
  return text.replaceAll(NBSP, "‿");
}

test("привязывает предлог к следующему слову", () => {
  assert.equal(visible(bindShortWords("вопрос о том")), "вопрос о‿том");
  assert.equal(visible(bindShortWords("В 2012 году")), "В‿2012 году");
});

test("не оставляет второй предлог цепочки на разрывном пробеле", () => {
  assert.equal(visible(bindShortWords("но в другом")), "но‿в‿другом");
  assert.equal(visible(bindShortWords("а и я тоже")), "а‿и‿я‿тоже");
});

test("ловит предлог после открывающей кавычки и скобки", () => {
  assert.equal(visible(bindShortWords("«в тексте»")), "«в‿тексте»");
  assert.equal(visible(bindShortWords("(по мнению)")), "(по‿мнению)");
});

test("связывает инициалы с фамилией и между собой", () => {
  assert.equal(visible(bindShortWords("В. Беньямин")), "В.‿Беньямин");
  assert.equal(visible(bindShortWords("А. Ф. Лосев")), "А.‿Ф.‿Лосев");
  assert.equal(visible(bindShortWords("М. М. Бахтина")), "М.‿М.‿Бахтина");
  assert.equal(visible(bindShortWords("Ж.-Ф. Лиотара")), "Ж.-Ф.‿Лиотара");
});

test("не трогает слова, которые лишь начинаются с предлога", () => {
  assert.equal(visible(bindShortWords("все виды искусства")), "все виды искусства");
  assert.equal(visible(bindShortWords("подход к делу")), "подход к‿делу");
});

test("повторный прогон ничего не добавляет", () => {
  const once = bindShortWords("Спор, начатый задолго до неё, у Ж. Бодрийяра.");
  assert.equal(bindShortWords(once), once);
});

test("оставляет длину строки прежней", () => {
  const source = "Это учение А. Ф. Лосева о символе и о смысле.";
  assert.equal(bindShortWords(source).length, source.length);
});
