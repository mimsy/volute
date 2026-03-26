export async function checkHealth(port: number): Promise<{ ok: boolean; name?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { name: string };
    return { ok: true, name: data.name };
  } catch {
    return { ok: false };
  }
}
