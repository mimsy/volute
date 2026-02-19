import { deletePagesConfig } from "../../lib/pages-config.js";

export async function run() {
  if (deletePagesConfig()) {
    console.log("Logged out. Credentials removed.");
  } else {
    console.log("Not logged in.");
  }
}
