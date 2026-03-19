/**
 * Shared parameter-based routing for merged operations.
 * DRY utility -- all 10 domain handlers use this instead of re-implementing action dispatch.
 *
 * @epic T5671
 */

export function routeByParam<T>(
  params: Record<string, unknown> | undefined,
  paramName: string,
  routes: Record<string, () => T>,
  defaultRoute?: string,
): T {
  const value = (params?.[paramName] as string) ?? defaultRoute;
  if (!value) {
    const available = Object.keys(routes).join(', ');
    throw new Error(`Missing required param '${paramName}'. Available: ${available}`);
  }
  const handler = routes[value];
  if (!handler) {
    const available = Object.keys(routes).join(', ');
    throw new Error(`Unknown ${paramName} '${value}'. Available: ${available}`);
  }
  return handler();
}
