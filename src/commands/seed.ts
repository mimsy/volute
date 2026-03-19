// Legacy alias — redirect to seed create
export async function run(args: string[]) {
  console.error("Note: `volute mind seed` is now `volute seed create`");
  await import("./seed-create.js").then((m) => m.run(args));
}
