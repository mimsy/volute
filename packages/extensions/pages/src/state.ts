/** Module-level state for the pages extension, set during initialization. */

let _dataDir: string | null = null;

export function setDataDir(dir: string): void {
  _dataDir = dir;
}

export function getDataDir(): string {
  if (!_dataDir) throw new Error("pages extension dataDir not initialized");
  return _dataDir;
}
