import type { Lecture } from "../types";
import { listLectures, putLecture } from "./db";

/**
 * 이미 있는 이름이면 뒤에 (1), (2)…를 붙여 겹치지 않게 한다.
 * "1차시 (1)"처럼 번호가 붙은 이름을 넣어도 번호를 떼고 다시 매긴다.
 */
export function uniqueTitle(desired: string, taken: string[]): string {
  const used = new Set(taken);
  if (!used.has(desired)) return desired;
  const base = desired.replace(/\s\(\d+\)$/, "");
  let n = 1;
  while (used.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/** 다른 차시와 이름이 겹치지 않게 이름을 바꾸고 저장한다 */
export async function renameLecture(lecture: Lecture, desired: string): Promise<Lecture> {
  const others = (await listLectures()).filter((l) => l.id !== lecture.id).map((l) => l.title);
  const next = { ...lecture, title: uniqueTitle(desired, others) };
  if (next.title !== lecture.title) await putLecture(next);
  return next;
}
