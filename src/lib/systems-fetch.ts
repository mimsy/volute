export async function systemsFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = (err as TypeError & { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code;
    const host = new URL(url).host;
    if (code === "ENOTFOUND") {
      console.error(`Could not resolve ${host}. Check your internet connection.`);
    } else if (code === "ECONNREFUSED") {
      console.error(`Connection refused by ${host}. The service may be down.`);
    } else {
      console.error(
        `Network error connecting to ${host}: ${cause?.message ?? (err as Error).message}`,
      );
    }
    process.exit(1);
  }
}
