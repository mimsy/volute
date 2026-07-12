import { randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { CronExpressionParser } from "cron-parser";
import { Hono } from "hono";
import { z } from "zod";
import { initRepo, listSnapshots, readBackupState, runBackup } from "../../lib/backup/backup.js";
import { RESTIC_INSTALL_HINT, resticVersion } from "../../lib/backup/restic.js";
import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/setup.js";
import { DEFAULT_BACKUP_SCHEDULE } from "../../lib/daemon/backup-manager.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

/**
 * Backup config with secrets redacted: password → hasPassword, env → key
 * names only. Built field-by-field (no spread) so a future BackupConfig field
 * can't reach the API without an explicit decision here.
 */
function redactedConfig() {
  const backup = readGlobalConfig().backup ?? {};
  return {
    repository: backup.repository,
    schedule: backup.schedule ?? DEFAULT_BACKUP_SCHEDULE,
    enabled: backup.enabled,
    keep: backup.keep,
    includeSessions: backup.includeSessions,
    hasPassword: !!backup.password,
    envKeys: Object.keys(backup.env ?? {}),
  };
}

const configSchema = z.object({
  repository: z.string().optional(),
  schedule: z
    .string()
    .refine(
      (cron) => {
        try {
          CronExpressionParser.parse(cron);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Invalid cron expression" },
    )
    .optional(),
  enabled: z.boolean().optional(),
  keep: z
    .object({
      daily: z.number().int().min(0).optional(),
      weekly: z.number().int().min(0).optional(),
      monthly: z.number().int().min(0).optional(),
    })
    .refine((keep) => !(keep.daily === 0 && keep.weekly === 0 && keep.monthly === 0), {
      message: "Retention cannot be zero everywhere — prune would delete every snapshot",
    })
    .optional(),
  includeSessions: z.boolean().optional(),
  password: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const backup = new Hono<AuthEnv>()
  .get("/config", requireAdmin, (c) => c.json(redactedConfig()))

  .put("/config", requireAdmin, zValidator("json", configSchema), (c) => {
    const updates = c.req.valid("json");
    const config = readGlobalConfig();
    const current = config.backup ?? {};
    config.backup = {
      ...current,
      ...updates,
      // Empty-string password means "keep existing" so the UI can save
      // settings without re-entering the passphrase.
      password: updates.password || current.password,
      env: updates.env ?? current.env,
    };
    writeGlobalConfig(config);
    return c.json(redactedConfig());
  })

  .post("/init", requireAdmin, async (c) => {
    const config = readGlobalConfig();
    if (!config.backup?.repository) {
      return c.json({ error: "Backup repository is not configured" }, 400);
    }
    let generatedPassword: string | null = null;
    if (!config.backup.password) {
      generatedPassword = randomBytes(32).toString("base64url");
      config.backup.password = generatedPassword;
    }
    try {
      await initRepo(config.backup);
    } catch (err) {
      // The generated passphrase is deliberately NOT persisted on failure:
      // a retry generates a fresh one, so a passphrase the host never
      // saw can't end up guarding the repository.
      const stderr = (err as Error & { stderr?: string }).stderr;
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: stderr?.trim() || detail }, 500);
    }
    if (generatedPassword) writeGlobalConfig(config);
    // The passphrase is returned exactly once, by the successful init that
    // generated it — the caller must surface it to the host.
    return c.json({ ok: true, password: generatedPassword });
  })

  .post("/run", requireAdmin, async (c) => {
    try {
      const summary = await runBackup();
      return c.json(summary);
    } catch (err) {
      const stderr = (err as Error & { stderr?: string }).stderr;
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: stderr?.trim() || detail }, 500);
    }
  })

  .get("/snapshots", requireAdmin, async (c) => {
    try {
      return c.json(await listSnapshots());
    } catch (err) {
      const stderr = (err as Error & { stderr?: string }).stderr;
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: stderr?.trim() || detail }, 500);
    }
  })

  .get("/status", requireAdmin, async (c) => {
    const version = await resticVersion();
    return c.json({
      resticInstalled: version !== null,
      resticVersion: version,
      installHint: version === null ? RESTIC_INSTALL_HINT : null,
      config: redactedConfig(),
      state: readBackupState(),
    });
  });

export default backup;
