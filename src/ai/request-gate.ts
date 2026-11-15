/** 即使已经排队的 Worker 消息稍后到达，也不能越过取消或新请求的边界。 */
export class RequestGate {
  private current = 0;
  next(): number { return ++this.current; }
  isCurrent(id: number): boolean { return id === this.current; }
}
