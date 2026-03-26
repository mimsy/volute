export {
  getPlatform,
  getPlatformDriver,
  type ImageAttachment,
  PLATFORMS,
  type Platform,
  type PlatformConversation,
  type PlatformDriver,
  type PlatformUser,
  registerPlatform,
  resolvePlatformId,
} from "@volute/platforms";

import { registerPlatform } from "@volute/platforms";
import * as volute from "./platforms/volute.js";

registerPlatform("volute", {
  name: "volute",
  displayName: "Volute",
  builtIn: true,
  driver: volute,
});
