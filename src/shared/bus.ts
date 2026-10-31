import type { InkEvent, LayerRequest } from './ink'

type Handler<T> = (value: T) => void

/** 편집기와 애니메이션 레이어를 잇는 작은 이벤트 통로 */
export class InkBus {
  private inkHandlers = new Set<Handler<InkEvent>>()
  private requestHandlers = new Set<Handler<LayerRequest>>()

  emit(event: InkEvent) {
    this.inkHandlers.forEach((h) => h(event))
  }

  onInk(handler: Handler<InkEvent>) {
    this.inkHandlers.add(handler)
    return () => {
      this.inkHandlers.delete(handler)
    }
  }

  request(request: LayerRequest) {
    this.requestHandlers.forEach((h) => h(request))
  }

  onRequest(handler: Handler<LayerRequest>) {
    this.requestHandlers.add(handler)
    return () => {
      this.requestHandlers.delete(handler)
    }
  }
}
