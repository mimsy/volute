import { createWriteStream, existsSync, statSync, type WriteStream } from "node:fs";
import { access, rename, rm } from "node:fs/promises";
import { Writable } from "node:stream";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export class RotatingLog extends Writable {
  private stream: WriteStream;
  private size: number;

  constructor(
    private readonly path: string,
    private readonly maxSize = MAX_SIZE,
    private readonly maxFiles = 5,
  ) {
    super();
    this.on("error", () => {});
    try {
      this.size = existsSync(path) ? statSync(path).size : 0;
    } catch {
      this.size = 0;
    }
    this.stream = createWriteStream(path, { flags: "a" });
  }

  private async rotateAsync(): Promise<void> {
    // Delete oldest if at limit
    const oldest = `${this.path}.${this.maxFiles}`;
    await access(oldest)
      .then(() => rm(oldest))
      .catch(() => {});

    // Shift existing rotated files up by one
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.path}.${i}`;
      const to = `${this.path}.${i + 1}`;
      await access(from)
        .then(() => rename(from, to))
        .catch(() => {});
    }

    await rename(this.path, `${this.path}.1`);
    const oldStream = this.stream;
    this.stream = createWriteStream(this.path);
    oldStream.end();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.size += chunk.length;
    if (this.size > this.maxSize) {
      this.rotateAsync()
        .then(() => {
          this.size = chunk.length;
          this.stream.write(chunk, callback);
        })
        .catch(() => {
          this.size = chunk.length;
          this.stream.write(chunk, callback);
        });
      return;
    }
    this.stream.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.stream.end(callback);
  }
}
