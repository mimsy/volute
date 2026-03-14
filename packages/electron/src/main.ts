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
    minWidth: 768,
    minHeight: 400,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Mark the page as running inside Electron so CSS can adapt
  mainWindow.webContents.on("dom-ready", () => {
    mainWindow?.webContents.executeJavaScript(`document.documentElement.classList.add("electron")`);
  });

  mainWindow.loadURL(`http://127.0.0.1:${daemon.getPort()}`);

  // Open external links in the default browser (validate protocol first)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) {
      shell.openExternal(url);
    }
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

type MindInfo = {
  name: string;
  status: "running" | "stopped" | "starting" | "sleeping";
  displayName?: string;
};

const STATUS_LABELS: Record<string, string> = {
  running: "●",
  starting: "◐",
  sleeping: "◌",
  stopped: "○",
};

function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemon.getPort()}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${daemon.getToken()}`,
    },
  });
}

async function fetchMinds(): Promise<MindInfo[]> {
  try {
    const res = await daemonFetch("/api/minds/");
    if (!res.ok) return [];
    const minds = (await res.json()) as MindInfo[];
    return minds.filter((m) => !("parent" in m));
  } catch {
    return [];
  }
}

async function toggleMind(name: string, currentStatus: string) {
  const action = currentStatus === "running" || currentStatus === "starting" ? "stop" : "start";
  try {
    await daemonFetch(`/api/minds/${name}/${action}`, { method: "POST" });
  } catch {
    // Daemon unavailable
  }
  await refreshTrayMenu();
}

async function refreshTrayMenu() {
  if (!tray) return;

  const minds = await fetchMinds();

  const mindItems: Electron.MenuItemConstructorOptions[] = minds.map((mind) => ({
    label: `${STATUS_LABELS[mind.status] ?? "○"} ${mind.displayName ?? mind.name}`,
    click: () => toggleMind(mind.name, mind.status),
  }));

  const template: Electron.MenuItemConstructorOptions[] = [
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
  ];

  if (mindItems.length > 0) {
    template.push(...mindItems, { type: "separator" });
  }

  template.push({
    label: "Quit",
    click: () => {
      isQuitting = true;
      app.quit();
    },
  });

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

let trayRefreshInterval: ReturnType<typeof setInterval> | null = null;

function createTray() {
  // macOS template images: trayTemplate.png and trayTemplate@2x.png
  const iconPath = isDev
    ? resolve(__dirname, "..", "resources", "trayTemplate.png")
    : join(process.resourcesPath!, "trayTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Volute");

  // Build initial menu, then refresh periodically
  refreshTrayMenu();
  trayRefreshInterval = setInterval(refreshTrayMenu, 10_000);

  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  if (trayRefreshInterval) clearInterval(trayRefreshInterval);
});

app
  .whenReady()
  .then(async () => {
    // Determine port — in dev mode, always use a separate port to avoid
    // reusing an existing daemon that serves different assets
    let port = DEFAULT_PORT;
    if (!(await isPortAvailable(port))) {
      if (isDev) {
        port = await findAvailablePort(port + 1);
      } else {
        // In production, reuse any healthy daemon already on this port
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (!res.ok) {
            port = await findAvailablePort(port + 1);
          }
        } catch {
          port = await findAvailablePort(port + 1);
        }
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
        console.log("[daemon]", line);
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
  })
  .catch((err) => {
    console.error("Fatal error during app startup:", err);
    app.quit();
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
