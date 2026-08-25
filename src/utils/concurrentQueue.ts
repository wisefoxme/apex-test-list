'use strict';

/**
 * Minimal in-house replacement for async's `queue`: runs a worker over a
 * list of tasks with a concurrency cap, resolving once all tasks finish
 * (or rejecting on the first error).
 */

type Worker<T> = (task: T, callback: (error?: Error) => void) => void;

export interface ConcurrentQueue<T> {
  push(tasks: T | T[]): Promise<void>;
}

export function createQueue<T>(worker: Worker<T>, concurrency: number): ConcurrentQueue<T> {
  return {
    push(tasks: T | T[]): Promise<void> {
      const items = Array.isArray(tasks) ? tasks : [tasks];

      return new Promise<void>((resolvePromise, reject) => {
        if (items.length === 0) {
          resolvePromise();
          return;
        }

        let index = 0;
        let active = 0;
        let settled = false;

        const runNext = (): void => {
          while (!settled && active < concurrency && index < items.length) {
            const item = items[index++];
            active++;
            worker(item, (error) => {
              // Stryker disable next-line ConditionalExpression: redundant with
              // runNext()'s own `!settled` check below — even without this early
              // return, a late callback can only ever reach a no-op runNext()
              // call once settled is true, since that check blocks it too.
              if (settled) return;
              if (error) {
                settled = true;
                reject(error);
                return;
              }
              active--;
              if (index >= items.length && active === 0) {
                // Stryker disable next-line BooleanLiteral: this branch only
                // fires once every item is dispatched (index >= items.length),
                // which independently blocks runNext()'s while loop from ever
                // dispatching again, regardless of this assignment's value.
                settled = true;
                resolvePromise();
                return;
              }
              runNext();
            });
          }
        };

        runNext();
      });
    },
  };
}
