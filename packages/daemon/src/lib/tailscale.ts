import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { voluteHome } from "./mind/registry.js";
import log from "./util/logger.js";

const execFileAsync = promisify(execFile);

const TLS_DIR = resolve(voluteHome(), "tls");

export interface TlsConfig {
  key: Buffer;
  cert: Buffer;
  hostname: string;
}

/** Get the Tailscale FQDN for this machine. */
async function getTailscaleHostname(): Promise<string> {
  const { stdout } = await execFileAsync("tailscale", ["status", "--json"]);
  const status = JSON.parse(stdout);
  const self = status.Self;
  if (!self?.DNSName) throw new Error("Could not determine Tailscale hostname");
  // DNSName has a trailing dot — remove it
  return self.DNSName.replace(/\.$/, "");
}

/** Fetch (or refresh) Tailscale HTTPS certs and return TLS config. */
export async function getTailscaleTls(): Promise<TlsConfig> {
  const hostname = await getTailscaleHostname();
  log.info("Tailscale hostname", { hostname });

  mkdirSync(TLS_DIR, { recursive: true });
  const certPath = resolve(TLS_DIR, "cert.pem");
  const keyPath = resolve(TLS_DIR, "key.pem");

  // tailscale cert writes cert+key files
  await execFileAsync("tailscale", [
    "cert",
    "--cert-file",
    certPath,
    "--key-file",
    keyPath,
    hostname,
  ]);

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error("tailscale cert did not produce expected files");
  }

  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    hostname,
  };
}
