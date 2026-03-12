import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { getOAuthProvider } from "@mariozechner/pi-ai";
import { aiComplete, getAiConfig, removeAiConfig, saveAiConfig } from "../lib/ai-service.js";
import { parseArgs } from "../lib/parse-args.js";
import { promptLine } from "../lib/prompt.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "config":
      return runConfig(args.slice(1));
    case "status":
      return runStatus();
    case "remove":
      return runRemove();
    case "--help":
    case "-h":
    case undefined:
      console.log(`volute ai — configure system AI service

Commands:
  config    Configure AI provider and model
  status    Show current AI configuration
  remove    Remove AI configuration

Config options:
  --provider <name>   AI provider (anthropic, openai, google, etc.)
  --model <id>        Model ID
  --api-key <key>     API key (optional — env vars work too)
  --oauth             Use OAuth device code flow`);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

async function runConfig(args: string[]) {
  const { flags } = parseArgs(args, {
    provider: { type: "string" },
    model: { type: "string" },
    "api-key": { type: "string" },
    oauth: { type: "boolean" },
  });

  let provider = flags.provider;
  let model = flags.model;
  const apiKey = flags["api-key"];
  const useOAuth = flags.oauth;

  // Interactive prompts if not provided
  if (!provider) {
    provider = await promptLine("Provider (anthropic, openai, google, etc.): ");
    if (!provider.trim()) {
      console.error("Provider is required.");
      process.exit(1);
    }
    provider = provider.trim();
  }

  if (!model) {
    model = await promptLine("Model ID: ");
    if (!model.trim()) {
      console.error("Model ID is required.");
      process.exit(1);
    }
    model = model.trim();
  }

  if (useOAuth) {
    const oauthProvider = getOAuthProvider(provider);
    if (!oauthProvider) {
      console.error(`OAuth not supported for provider: ${provider}`);
      process.exit(1);
    }

    console.log(`Starting OAuth flow for ${oauthProvider.name}...`);
    try {
      const credentials: OAuthCredentials = await oauthProvider.login({
        onAuth: (info) => {
          console.log(`\nOpen this URL to authorize:\n  ${info.url}`);
          if (info.instructions) console.log(`  ${info.instructions}`);
          console.log("\nWaiting for authorization...");
        },
        onPrompt: async (prompt) => {
          return await promptLine(prompt.message + " ");
        },
      });
      saveAiConfig({ provider, model, oauth: credentials });
      console.log(`\nAI service configured: ${provider} / ${model} (OAuth)`);
    } catch (err) {
      console.error(`OAuth failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else if (apiKey) {
    saveAiConfig({ provider, model, apiKey });
    console.log(`AI service configured: ${provider} / ${model} (API key)`);
  } else {
    saveAiConfig({ provider, model });
    console.log(`AI service configured: ${provider} / ${model} (using env var)`);
  }
}

async function runStatus() {
  const config = getAiConfig();
  if (!config) {
    console.log("AI service: not configured");
    return;
  }

  const authMethod = config.oauth ? "OAuth" : config.apiKey ? "API key" : "env var";
  console.log(`AI service:`);
  console.log(`  Provider: ${config.provider}`);
  console.log(`  Model:    ${config.model}`);
  console.log(`  Auth:     ${authMethod}`);

  // Quick connectivity check
  const result = await aiComplete("Respond with just 'ok'.", "ping");
  if (result) {
    console.log(`  Status:   available`);
  } else {
    console.log(`  Status:   unavailable (check credentials)`);
  }
}

function runRemove() {
  const config = getAiConfig();
  if (!config) {
    console.log("AI service is not configured.");
    return;
  }
  removeAiConfig();
  console.log("AI configuration removed.");
}
