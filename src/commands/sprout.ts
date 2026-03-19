// Legacy alias — redirect to seed sprout
export async function run(args: string[]) {
  console.error("Note: `volute mind sprout` is now `volute seed sprout`");
  await import("./seed-sprout.js").then((m) => m.run(args));
}
