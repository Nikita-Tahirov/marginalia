// Размер текста статьи. Вычитка идёт часами и на чужом экране: кегль, удобный
// автору макета, читателю бывает мелок или, наоборот, гонит строку в две
// колонки. Масштаб задаётся шагами, а не свободным числом, — человек нажимает
// кнопку, а не подбирает проценты, и любое сохранённое значение приводится к
// известной ступени.
export const READING_SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];

export const DEFAULT_SCALE = 1;

const SCALE_KEY = "marginalia:reading-scale";

// Числа в шкале дробные, и равенство по ним ненадёжно: 1.1 из хранилища и 1.1
// из массива совпадут, а вот сумма 0.8 + 0.1 + 0.2 — уже нет. Поэтому ступень
// ищем по наименьшему расхождению, а не по точному совпадению.
export function normalizeScale(value) {
  // parseFloat, а не Number: пустая строка и null дают у Number ноль, и вместо
  // «значения нет» получилась бы самая мелкая ступень шкалы.
  const number = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(number)) return DEFAULT_SCALE;
  let closest = READING_SCALES[0];
  for (const step of READING_SCALES) {
    if (Math.abs(step - number) < Math.abs(closest - number)) closest = step;
  }
  return closest;
}

// Направление, а не готовое значение: кнопка знает только «крупнее» и «мельче»,
// а границы шкалы держит одно место. На краю остаёмся на месте — там кнопка и
// так погашена.
export function stepScale(current, direction) {
  const index = READING_SCALES.indexOf(normalizeScale(current));
  const next = index + Math.sign(direction);
  return READING_SCALES[Math.min(READING_SCALES.length - 1, Math.max(0, next))];
}

export function readStoredScale(storage) {
  try {
    const saved = storage?.getItem(SCALE_KEY);
    return saved === null || saved === undefined ? DEFAULT_SCALE : normalizeScale(saved);
  } catch {
    return DEFAULT_SCALE;
  }
}

// В приватном режиме и при запрете хранилища бросает уже само обращение к
// свойству, а не только запись.
function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// Размер общий для всех документов: человек выбирает его под свои глаза и свой
// экран, а не под конкретную статью, и заново подбирать его при каждом открытии
// незачем.
export function setUpReadingScale({ root, smaller, larger, onChange }) {
  const storage = safeStorage();
  let scale = readStoredScale(storage);

  function apply(next, remember) {
    scale = next;
    root.style.setProperty("--reading-scale", String(scale));
    root.dataset.readingScale = String(scale);
    if (smaller) smaller.disabled = scale === READING_SCALES[0];
    if (larger) larger.disabled = scale === READING_SCALES.at(-1);
    if (remember) {
      try {
        storage?.setItem(SCALE_KEY, String(scale));
      } catch {
        // Запись недоступна (приватный режим, запрет хранилища) — размер просто
        // не переживёт перезагрузку, читать это не мешает.
      }
    }
    onChange?.(scale);
  }

  smaller?.addEventListener("click", () => apply(stepScale(scale, -1), true));
  larger?.addEventListener("click", () => apply(stepScale(scale, 1), true));
  apply(scale, false);
}
