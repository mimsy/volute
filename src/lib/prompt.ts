export function promptLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const byte of buf) {
        if (byte === 3) {
          process.stderr.write("\n");
          process.exit(1);
        }
        if (byte === 13 || byte === 10) {
          process.stderr.write("\n");
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
        } else {
          value += String.fromCharCode(byte);
        }
      }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
