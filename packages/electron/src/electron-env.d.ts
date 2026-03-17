// Electron adds resourcesPath to process
declare namespace NodeJS {
  interface Process {
    resourcesPath?: string;
  }
}
