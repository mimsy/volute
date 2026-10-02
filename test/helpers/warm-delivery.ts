/**
 * Load the modules `deliverEvent` imports lazily, so the first delivery in a test
 * process doesn't pay for them inside a timed assertion (#1289).
 *
 * system-events.ts dynamically imports the sleep-manager and delivery-manager module
 * graphs on its delivery paths. Cold through tsx that is ~0.8s on a busy box and took
 * 5–6s at load 40, blocking the event loop — so a timer a test was racing couldn't
 * fire until it finished (#1258). The daemon imports both statically and the build
 * bundles them, so production never pays this. Call it from a `before()` in any file
 * that bounds a first delivery with a clock.
 */
export async function warmDeliveryPath(): Promise<void> {
  await Promise.all([
    import("../../packages/daemon/src/lib/daemon/sleep-manager.js"),
    import("../../packages/daemon/src/lib/delivery/delivery-manager.js"),
  ]);
}
