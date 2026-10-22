/** Skip interval ticks while the previous operation is still unsettled.
 * Never release on a timeout: the underlying operation could still mutate state.
 */
export function singleFlight<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
  skipped: () => Result,
) {
  let running = false;
  return async (...args: Args): Promise<Result> => {
    if (running) return skipped();
    running = true;
    try {
      return await operation(...args);
    } finally {
      running = false;
    }
  };
}
