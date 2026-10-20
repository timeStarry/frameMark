export class Jobs {
  version = 0

  start(): number {
    return ++this.version
  }

  cancel(): void {
    ++this.version
  }

  check(id: number): void {
    if (id !== this.version) {
      throw new DOMException('已取消', 'AbortError')
    }
  }
}

/** Serialize preview/export jobs so cancelled browser decodes cannot multiply working memory. */
export class SerialGate {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }
}
