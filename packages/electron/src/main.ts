import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import { DaemonProcess, findAvailablePort, isPortAvailable } from "./daemon.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = !app.isPackaged;

// --- Path resolution ---

function resourcePath(...parts: string[]): string {
  if (isDev) {
    // In dev, __dirname is packages/electron/dist/, repo root is three levels up
    return resolve(__dirname, "..", "..", "..", ...parts);
  }
  return join(process.resourcesPath!, ...parts);
}

const binDir = resourcePath("bin");
const nodePath = isDev ? process.execPath : join(binDir, "node");
const daemonScript = resourcePath("dist", "daemon.js");
const nodeModulesDir = resourcePath("node_modules");
const voluteHome = isDev
  ? resolve(homedir(), ".volute")
  : resolve(homedir(), "Library", "Application Support", "Volute");

// --- App lifecycle ---

const DEFAULT_PORT = 1618;
let daemon: DaemonProcess;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${daemon.getPort()}`);

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("close", (e: Electron.Event) => {
    // Hide instead of close (keep running in tray)
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Volute");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Window",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on("before-quit", () => {
  isQuitting = true;
});

app.whenReady().then(async () => {
  // Determine port
  let port = DEFAULT_PORT;
  if (!(await isPortAvailable(port))) {
    // Check if it's an existing Volute daemon we can reuse
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (!res.ok) {
        port = await findAvailablePort(port + 1);
      }
    } catch {
      port = await findAvailablePort(port + 1);
    }
  }

  daemon = new DaemonProcess({
    nodePath,
    daemonScript,
    port,
    voluteHome,
    binDir,
    nodeModulesDir,
    onLog: (line) => {
      if (isDev) process.stdout.write(line);
    },
  });

  try {
    await daemon.start();
  } catch (err) {
    console.error("Failed to start daemon:", err);
    app.quit();
    return;
  }

  createTray();
  await createWindow();
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  // On macOS, don't quit when all windows are closed
  if (process.platform !== "darwin") {
    isQuitting = true;
    app.quit();
  }
});

app.on("will-quit", (e) => {
  e.preventDefault();
  daemon
    .stop()
    .catch((err) => console.error("Error stopping daemon:", err))
    .finally(() => process.exit(0));
});
