import type { Subprocess } from "bun";

/**
 * Spawns a real newgl-ai process (its own repo/package, own Bun runtime) on
 * a free local port, matching the real browser -> newgl-api -> newgl-ai
 * chain (AI_INTEGRATION_PLAN.md Part 1) instead of importing its modules
 * in-process -- the two services have separate tsconfig path aliases, so a
 * cross-repo import isn't viable, and spawning a real process is also a
 * closer match to production anyway.
 *
 * AI_FAKE_KEY_VALIDATION=true swaps in a deterministic fake Anthropic
 * validator (see newgl-ai/src/testing/fake-key-validator.ts) so these tests
 * never make a real network call or need a real Anthropic account.
 */
export type NewglAiTestServer = {
  baseUrl: string;
  internalToken: string;
  stop(): void;
};

const NEWGL_AI_DIR = new URL("../../../newgl-ai", import.meta.url).pathname;

export async function startNewglAiForTests(): Promise<NewglAiTestServer | null> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  const port = 20000 + Math.floor(Math.random() * 20000);
  const internalToken = "test-internal-token-" + crypto.randomUUID();

  let child: Subprocess;
  try {
    child = Bun.spawn({
      cmd: ["bun", "src/index.ts"],
      cwd: NEWGL_AI_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        INTERNAL_SERVICE_TOKEN: internalToken,
        AI_KEY_ENCRYPTION_KEY: "Eo0pUoxiqHb5h1QlSUcD07lVfiqi3kOcovq2CaSmLew=",
        ANTHROPIC_API_KEY: "sk-ant-test-valid-platform-key",
        ANTHROPIC_MODEL: "claude-opus-4-8",
        AI_FAKE_KEY_VALIDATION: "true"
      },
      stdout: "ignore",
      stderr: "ignore"
    });
  } catch {
    return null;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const healthy = await waitForHealth(baseUrl, child);
  if (!healthy) {
    child.kill();
    return null;
  }

  return {
    baseUrl,
    internalToken,
    stop: () => child.kill()
  };
}

async function waitForHealth(baseUrl: string, child: Subprocess, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${baseUrl}/internal/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
