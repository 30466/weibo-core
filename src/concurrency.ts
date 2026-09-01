export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

export class AsyncSemaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('并发上限必须是正整数')
    this.available = Math.floor(limit)
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.available++
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }
}

export interface AsyncTaskGateLease {
  gate: {
    run<T>(task: () => Promise<T>): Promise<T>
  }
  /** Marks a phase-one task complete if it failed before entering its gate. */
  complete(): void
}

/**
 * Runs every phase-one task serially, blocks phase two until all phase-one
 * tasks have completed, then allows phase two to use its configured limit.
 */
export class AsyncTwoPhaseGate {
  private readonly firstPhaseGate = new AsyncSemaphore(1)
  private readonly secondPhaseGate: AsyncSemaphore
  private readonly firstPhaseDone: Promise<void>
  private resolveFirstPhaseDone: (() => void) | undefined
  private remainingFirstPhaseTasks: number

  constructor(firstPhaseTaskCount: number, secondPhaseConcurrency: number) {
    this.remainingFirstPhaseTasks = Math.max(0, Math.floor(firstPhaseTaskCount))
    this.secondPhaseGate = new AsyncSemaphore(secondPhaseConcurrency)
    this.firstPhaseDone = this.remainingFirstPhaseTasks === 0
      ? Promise.resolve()
      : new Promise<void>(resolve => { this.resolveFirstPhaseDone = resolve })
  }

  createFirstPhaseLease(): AsyncTaskGateLease {
    let completed = false
    const complete = (): void => {
      if (completed) return
      completed = true
      this.remainingFirstPhaseTasks--
      if (this.remainingFirstPhaseTasks === 0) {
        this.resolveFirstPhaseDone?.()
        this.resolveFirstPhaseDone = undefined
      }
    }
    return {
      gate: {
        run: task => this.firstPhaseGate.run(async () => {
          try {
            return await task()
          } finally {
            complete()
          }
        }),
      },
      complete,
    }
  }

  readonly secondPhase = {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      await this.firstPhaseDone
      return this.secondPhaseGate.run(task)
    },
  }
}
