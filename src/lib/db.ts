import type { Lecture, Stroke } from "../types";

// 브라우저 IndexedDB 저장소
// lectures: 차시 정보, pdfs: 차시별 원본 PDF, strokes: "차시id/페이지id" → 필기 목록
type StoreName = "lectures" | "pdfs" | "strokes";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("professor", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("lectures", { keyPath: "id" });
      db.createObjectStore("pdfs");
      db.createObjectStore("strokes");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode = "readonly") {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

const strokeKey = (lectureId: string, pageId: string) => `${lectureId}/${pageId}`;
const lectureRange = (lectureId: string) =>
  IDBKeyRange.bound(`${lectureId}/`, `${lectureId}/￿`);

export async function listLectures(): Promise<Lecture[]> {
  const all: Lecture[] = await wrap((await store("lectures")).getAll());
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getLecture(id: string): Promise<Lecture | undefined> {
  return wrap((await store("lectures")).get(id));
}

export async function putLecture(lecture: Lecture): Promise<void> {
  await wrap((await store("lectures", "readwrite")).put(lecture));
}

export async function deleteLecture(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(["lectures", "pdfs", "strokes"], "readwrite");
  tx.objectStore("lectures").delete(id);
  tx.objectStore("pdfs").delete(id);
  tx.objectStore("strokes").delete(lectureRange(id));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPdf(lectureId: string): Promise<ArrayBuffer | undefined> {
  return wrap((await store("pdfs")).get(lectureId));
}

export async function putPdf(lectureId: string, data: ArrayBuffer): Promise<void> {
  await wrap((await store("pdfs", "readwrite")).put(data, lectureId));
}

export async function getAllStrokes(lectureId: string): Promise<Record<string, Stroke[]>> {
  const s = await store("strokes");
  const range = lectureRange(lectureId);
  const [keys, values] = await Promise.all([wrap(s.getAllKeys(range)), wrap(s.getAll(range))]);
  const result: Record<string, Stroke[]> = {};
  keys.forEach((key, i) => {
    result[String(key).slice(lectureId.length + 1)] = values[i];
  });
  return result;
}

export async function deleteStrokes(lectureId: string, pageId: string): Promise<void> {
  await wrap((await store("strokes", "readwrite")).delete(strokeKey(lectureId, pageId)));
}

export async function putStrokes(lectureId: string, pageId: string, strokes: Stroke[]): Promise<void> {
  await wrap((await store("strokes", "readwrite")).put(strokes, strokeKey(lectureId, pageId)));
}
