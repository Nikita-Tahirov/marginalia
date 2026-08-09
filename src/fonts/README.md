# Шрифты приложения

Все гарнитуры лежат здесь намеренно: во время работы приложение не обращается
к внешним серверам за шрифтами. Иначе Google получал бы адрес каждого читателя
при открытии страницы, а без сети заголовки теряли бы начертание.

## Cormorant Garamond и Lora

Подмножества `latin`, `latin-ext` и `cyrillic` в начертаниях 400 и 600 —
двенадцать файлов вида `<гарнитура>-<начертание>-<подмножество>.woff2`.
`latin-ext` оставлен ради иноязычной библиографии в научных статьях.
Правила `@font-face` с их `unicode-range` живут в начале `src/styles.css`,
поэтому браузер скачивает только те подмножества, которые встретились в тексте.

Источник: <https://fonts.google.com> (адреса файлов берутся из ответа
`https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Lora:wght@400;600&display=swap`
при запросе с современным User-Agent).
Лицензия обеих гарнитур: SIL Open Font License 1.1 — она прямо разрешает
размещение файлов на своём сервере.

## Material Symbols Rounded

`material-symbols-rounded.woff2` — подмножество шрифта Material Symbols Rounded,
содержащее девять глифов, которые использует интерфейс: `menu_book`, `add_comment`,
`visibility`, `edit`, `help`, `delete`, `autorenew`, `content_copy`, `download`.
Имена работают как лигатуры, поэтому разметка остаётся читаемой.

Источник: <https://github.com/google/material-design-icons> (подмножество получено
через `https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20,400,0,0&icon_names=add_comment,autorenew,content_copy,delete,download,edit,help,menu_book,visibility`).
Лицензия: Apache License 2.0, <https://www.apache.org/licenses/LICENSE-2.0>.

Файл лежит в репозитории намеренно: приложение не обращается к внешним серверам
за шрифтом иконок во время работы. Чтобы добавить иконку, запросите подмножество
заново с расширенным списком `icon_names` и замените файл.
