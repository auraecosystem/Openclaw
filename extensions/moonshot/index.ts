import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { MOONSHOT_THINKING_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import { applyMoonshotNativeStreamingUsageCompat } from "./api.js";
import { moonshotMediaUnderstandingProvider } from "./media-understanding-provider.js";
import {
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildMoonshotProvider } from "./provider-catalog.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const PROVIDER_ID = "moonshot";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  description: "Bundled Moonshot provider plugin",
  provider: {
    label: "Moonshot",
    docsPath: "/providers/moonshot",
    aliases: ["moonshotai", "moonshot-ai"],
    auth: [
      {
        methodId: "api-key",
        label: "Kimi API key (.ai)",
        hint: "Kimi K2.6 + Kimi",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfig(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.6)",
        },
      },
      {
        methodId: "api-key-cn",
        label: "Kimi API key (.cn)",
        hint: "Kimi K2.6 + Kimi",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key (.cn)",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfigCn(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.6)",
        },
      },
    ],
    catalog: {
      buildProvider: buildMoonshotProvider,
      buildStaticProvider: buildMoonshotProvider,
      allowExplicitBaseUrl: true,
    },
    applyNativeStreamingUsageCompat: ({ providerConfig }) =>
      applyMoonshotNativeStreamingUsageCompat(providerConfig),
    // Kimi K2+ returns native tool_call IDs shaped like `functions.<name>:<index>`.
    // Sanitizing them to alphanumeric-only breaks Kimi's serving-layer matching in
    // multi-turn replay (openclaw/openclaw#62319), but leaving them untouched lets
    // the runner replay the same id twice and Moonshot rejects the second turn
    // with HTTP 400 `tool call id <id> is duplicated` in long sessions and group
    // chats (openclaw/openclaw#51593). Compose the OpenAI-compatible family hooks
    // first to keep the existing per-message sanitisation, then override
    // `buildReplayPolicy` so the occurrence-aware sanitiser preserves the first
    // native Kimi id and only rewrites later duplicates.
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      sanitizeToolCallIds: false,
      dropReasoningFromHistory: false,
    }),
    buildReplayPolicy: (ctx: ProviderReplayPolicyContext): ProviderReplayPolicy => ({
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeKimiToolCallIds: true,
      ...(ctx.modelApi === "anthropic-messages" ? { preserveNativeAnthropicToolUseIds: true } : {}),
    }),
    ...MOONSHOT_THINKING_STREAM_HOOKS,
    resolveThinkingProfile: () => ({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    }),
  },
  register(api) {
    api.registerMediaUnderstandingProvider(moonshotMediaUnderstandingProvider);
    api.registerWebSearchProvider(createKimiWebSearchProvider());
  },
});
