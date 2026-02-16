import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import {
  getDaemonUrl,
  getServiceMode,
  HEALTH_POLL_TIMEOUT,
  LAUNCHD_PLIST_LABEL,
  LAUNCHD_PLIST_PATH,
  modeLabel,
  POLL_INTERVAL,
  pollHealth,
  pollHealthDown,
  type ServiceMode,
  STOP_GRACE_TIMEOUT,
  SYSTEM_SERVICE_PATH,
  USER_SYSTEMD_UNIT,
} from "../src/lib/service-mode.js";

describe("service-mode constants", () => {
  it("has expected constant values", () => {
    assert.equal(SYSTEM_SERVICE_PATH, "/etc/systemd/system/volute.service");
    assert.ok(USER_SYSTEMD_UNIT.endsWith(".config/systemd/user/volute.service"));
    assert.equal(LAUNCHD_PLIST_LABEL, "com.volute.daemon");
    assert.ok(LAUNCHD_PLIST_PATH.endsWith("Library/LaunchAgents/com.volute.daemon.plist"));
    assert.equal(HEALTH_POLL_TIMEOUT, 30_000);
    assert.equal(STOP_GRACE_TIMEOUT, 10_000);
    assert.equal(POLL_INTERVAL, 500);
  });
});

describe("getServiceMode", () => {
  it("returns a valid ServiceMode value", () => {
    const mode = getServiceMode();
    const validModes: ServiceMode[] = ["manual", "system", "user-systemd", "user-launchd"];
    assert.ok(validModes.includes(mode), `got unexpected mode: ${mode}`);
  });
});

describe("getDaemonUrl", () => {
  it("builds URL from hostname and port", () => {
    assert.equal(getDaemonUrl("127.0.0.1", 4200), "http://127.0.0.1:4200");
  });

  it("maps 0.0.0.0 to localhost", () => {
    assert.equal(getDaemonUrl("0.0.0.0", 4200), "http://localhost:4200");
  });

  it("maps :: to localhost", () => {
    assert.equal(getDaemonUrl("::", 4200), "http://localhost:4200");
  });

  it("uses custom port", () => {
    assert.equal(getDaemonUrl("myhost", 5000), "http://myhost:5000");
  });

  it("handles IPv6 literal", () => {
    assert.equal(getDaemonUrl("::1", 4200), "http://[::1]:4200");
  });
});

describe("pollHealth", () => {
  it("returns false when endpoint is unreachable", async () => {
    const result = await pollHealth("127.0.0.1", 19999, 1000);
    assert.equal(result, false);
  });

  it("returns true when endpoint responds with { ok: true }", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);
    try {
      const result = await pollHealth("127.0.0.1", port, 3000);
      assert.equal(result, true);
    } finally {
      server.close();
    }
  });

  it("returns false when endpoint responds without ok:true", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not-volute" }));
    });
    const port = await listen(server);
    try {
      const result = await pollHealth("127.0.0.1", port, 1000);
      assert.equal(result, false);
    } finally {
      server.close();
    }
  });
});

describe("pollHealthDown", () => {
  it("returns true immediately when endpoint is unreachable", async () => {
    const start = Date.now();
    const result = await pollHealthDown("127.0.0.1", 19999, 5000);
    assert.equal(result, true);
    assert.ok(Date.now() - start < 2000);
  });

  it("returns true when endpoint responds without ok:true", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not-volute" }));
    });
    const port = await listen(server);
    try {
      const result = await pollHealthDown("127.0.0.1", port, 3000);
      assert.equal(result, true);
    } finally {
      server.close();
    }
  });

  it("returns false (times out) when endpoint keeps responding with ok:true", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);
    try {
      const result = await pollHealthDown("127.0.0.1", port, 1000);
      assert.equal(result, false);
    } finally {
      server.close();
    }
  });
});

describe("modeLabel", () => {
  it("returns human-readable labels", () => {
    assert.equal(modeLabel("system"), "system service (systemd)");
    assert.equal(modeLabel("user-systemd"), "user service (systemd)");
    assert.equal(modeLabel("user-launchd"), "user service (launchd)");
    assert.equal(modeLabel("manual"), "manual");
  });
});

/** Helper: listen on a random port and return it */
function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("Could not get server address"));
    });
  });
}
