/**
 * Next's one hook that runs before the server takes a request.
 *
 * It is awaited, which is exactly what is wanted here: an instance must not answer `/api/ready` with
 * a green light while its store is still empty.
 */
export async function register(): Promise<void> {
  // The hook also runs on the edge runtime, where there is no store and no filesystem.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { bootstrapWorkspace } = await import('./lib/content/boot')
  await bootstrapWorkspace()
}
