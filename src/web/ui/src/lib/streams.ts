function createSSEStream(
  url: string,
  onLine: (line: string) => void,
  onError?: (msg: string) => void,
) {
  let controller: AbortController | null = null;

  function start() {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;

    fetch(url, { signal })
      .then(async (res) => {
        if (!res.ok) {
          onError?.(`Stream connection failed (${res.status})`);
          return;
        }
        if (!res.body) {
          onError?.("Stream has no body");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data) onLine(data);
          }
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        onError?.(err.message || "Stream error");
      });
  }

  function stop() {
    controller?.abort();
  }

  return { start, stop };
}

export function createLogStream(
  name: string,
  onLine: (line: string) => void,
  onError?: (msg: string) => void,
) {
  return createSSEStream(`/api/minds/${name}/logs`, onLine, onError);
}

export function createSystemLogStream(
  onLine: (line: string) => void,
  onError?: (msg: string) => void,
) {
  return createSSEStream("/api/system/logs", onLine, onError);
}
