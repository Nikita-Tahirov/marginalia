// Документы и рецензии живут в IndexedDB, а не в памяти вкладки: работа над
// статьёй растягивается на несколько вечеров, и закрытая вкладка не должна
// стирать её. Текст статьи и записи рецензии лежат раздельно — замечания
// добавляют часто, и перезаписывать вместе с ними всю статью незачем.
const DATABASE = "marginalia";
const VERSION = 1;
const DOCUMENTS = "documents";
const REVIEWS = "reviews";

let connection = null;

function openDatabase() {
  if (connection) return connection;
  connection = new Promise((resolve) => {
    let request;
    try {
      // Обращение к самому свойству тоже способно бросить: в приватном режиме
      // и при запрете хранилища браузер отдаёт не undefined, а исключение.
      if (typeof indexedDB === "undefined" || !indexedDB) {
        resolve(null);
        return;
      }
      request = indexedDB.open(DATABASE, VERSION);
    } catch {
      // Хранилище запрещено настройками браузера — работаем в памяти.
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCUMENTS)) {
        const store = db.createObjectStore(DOCUMENTS, { keyPath: "id" });
        store.createIndex("sha256", "sha256", { unique: false });
        store.createIndex("familyId", "familyId", { unique: false });
      }
      if (!db.objectStoreNames.contains(REVIEWS)) {
        db.createObjectStore(REVIEWS, { keyPath: "documentId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return connection;
}

function run(storeNames, mode, action) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let transaction;
        try {
          transaction = db.transaction(storeNames, mode);
        } catch {
          resolve(null);
          return;
        }
        let outcome;
        transaction.oncomplete = () => resolve(outcome ?? null);
        transaction.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
        // Отказ приходит не только событием: put и get бросают прямо в момент
        // вызова — когда транзакция уже неактивна, соединение закрыто или
        // значение отказались клонировать. Без этого перехвата такой отказ
        // становился отклонённым обещанием, а вызывающая сторона ждёт здесь
        // null: отказ терялся вместе со всей работой, которую нёс вызов.
        let request;
        try {
          request = action(
            Array.isArray(storeNames)
              ? storeNames.map((name) => transaction.objectStore(name))
              : transaction.objectStore(storeNames),
          );
        } catch {
          resolve(null);
          return;
        }
        if (request) request.onsuccess = () => (outcome = request.result);
      }),
  );
}

export function storageAvailable() {
  return openDatabase().then((db) => Boolean(db));
}

// Без устойчивого режима Safari удаляет данные источника после семи суток без
// взаимодействия, а прочие браузеры — при нехватке места на диске. Просить
// устойчивость имеет смысл в момент, когда появились данные, которые больно
// потерять, а не при первом открытии пустого приложения.
// Узнать состояние, ничего не запрашивая: показать положение дел можно и до
// того, как появится повод просить устойчивость.
export async function storageIsPersistent() {
  if (!navigator.storage?.persisted) return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function listDocuments() {
  return run(DOCUMENTS, "readonly", (store) => store.getAll()).then((rows) =>
    (rows ?? []).sort((left, right) => {
      if (left.familyId !== right.familyId) return left.createdAt - right.createdAt;
      return left.version - right.version;
    }),
  );
}

export function findByHash(sha256) {
  return run(DOCUMENTS, "readonly", (store) => store.index("sha256").get(sha256));
}

export function saveDocument(document) {
  return run(DOCUMENTS, "readwrite", (store) => store.put(document));
}

export function deleteDocument(id) {
  return run([DOCUMENTS, REVIEWS], "readwrite", ([documents, reviews]) => {
    reviews.delete(id);
    return documents.delete(id);
  });
}

export function loadReview(documentId) {
  return run(REVIEWS, "readonly", (store) => store.get(documentId));
}

export function saveReview(documentId, entries, sequence) {
  return run(REVIEWS, "readwrite", (store) =>
    store.put({ documentId, entries, sequence, updatedAt: Date.now() }),
  );
}
