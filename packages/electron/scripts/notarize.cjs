// electron-builder afterSign hook for notarization
// Only runs when APPLE_ID, APPLE_APP_PASSWORD, and APPLE_TEAM_ID are set
const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  if (!process.env.APPLE_ID || !process.env.APPLE_APP_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.log("Skipping notarization — APPLE_ID, APPLE_APP_PASSWORD, or APPLE_TEAM_ID not set");
    return;
  }

  const appName = context.packager.appInfo.productFilename;

  console.log(`Notarizing ${appName}...`);
  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
  console.log("Notarization complete");
};
