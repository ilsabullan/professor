// crypto.randomUUID는 https에서만 동작해서 (아이패드에서 http로 접속하는 경우) 직접 만든다
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
