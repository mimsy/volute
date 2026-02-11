import { createWriteStream, existsSync, renameSync, statSync, type WriteStream } from "node:fs";
import { Writable } from "node:stream";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export class RotatingLog extends Writable {
  private stream: WriteStream;
  private size: number;

  constructor(
    private readonly path: string,
    private readonly maxSize = MAX_SIZE,
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

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.size += chunk.length;
    if (this.size > this.maxSize) {
      try {
        renameSync(this.path, `${this.path}.1`);
        const oldStream = this.stream;
        this.stream = createWriteStream(this.path);
        this.size = chunk.length;
        oldStream.end();
      } catch {
        // Rotation failed — continue writing to the current stream
      }
    }
    this.stream.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.stream.end(callback);
  }
}
