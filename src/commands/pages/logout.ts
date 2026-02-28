import { deleteSystemsConfig } from "../../lib/systems-config.js";

export async function run() {
  if (deleteSystemsConfig()) {
    console.log("Logged out. Credentials removed.");
  } else {
    console.log("Not logged in.");
  }
}
