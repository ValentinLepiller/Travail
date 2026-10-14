// @effect-diagnostics globalFetch:off - Authenticated admission lease; unknown servers fail before shutdown.
import { withProbeSession } from "./auth.ts";
import type { RuntimeConfig } from "./config.ts";

export async function admissionLease(
  config: RuntimeConfig,
  action: "quiesce" | "release",
  operationId: string,
) {
  return withProbeSession(config, "environment:maintain", async (token) => {
    const response = await fetch(
      `http://127.0.0.1:${config.port}/api/harness/maintenance/${action}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, operationId }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new Error(`Admission ${action} refused (${response.status}); host was not stopped`);
    const proof = (await response.json()) as {
      version?: unknown;
      operationId?: unknown;
      released?: unknown;
      quiesced?: unknown;
      activeWork?: unknown;
      activeVoice?: unknown;
      activeDesktops?: unknown;
    };
    if (proof.version !== 1 || proof.operationId !== operationId)
      throw new Error("Admission lease identity mismatch");
    if (action === "release" && proof.released !== true)
      throw new Error("Admission was not released");
    if (
      action === "quiesce" &&
      (proof.quiesced !== true ||
        proof.activeWork !== 0 ||
        proof.activeVoice !== 0 ||
        proof.activeDesktops !== 0)
    )
      throw new Error("Host is not quiescent; no shutdown permitted");
  });
}
