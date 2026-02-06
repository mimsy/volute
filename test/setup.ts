import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Use a temporary database for tests so we don't destroy production data
process.env.VOLUTE_DB_PATH = resolve(tmpdir(), "volute-test.db");
