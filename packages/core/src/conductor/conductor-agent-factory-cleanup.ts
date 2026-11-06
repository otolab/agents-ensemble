const incompleteFactoryCleanupErrors = new WeakSet<AggregateError>();

/**
 * Keep the existing AggregateError API while marking factory failures whose
 * partial-startup cleanup did not complete.
 */
export function markConductorAgentFactoryCleanupIncomplete<
  T extends AggregateError,
>(error: T): T {
  incompleteFactoryCleanupErrors.add(error);
  return error;
}

export function isConductorAgentFactoryCleanupIncomplete(
  error: unknown,
): error is AggregateError {
  return (
    error instanceof AggregateError &&
    incompleteFactoryCleanupErrors.has(error)
  );
}
