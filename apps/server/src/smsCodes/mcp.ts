import { OrchestratorMcpFailure, SmsCode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Tool, Toolkit } from "effect/ai";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as SmsCodes from "./SmsCodes.ts";

export const toolkit = Toolkit.make(
  Tool.make("sms_codes_read", {
    description:
      "Read unexpired Okta SMS codes deposited by the user's phone. Supply notBefore as Unix milliseconds for the login you are completing. Only use for a user-authorized login. Codes are confidential data: do not repeat them in chat, logs or memory. Empty means no matching code has been deposited; it does not prove the phone is connected.",
    parameters: Schema.Struct({
      notBefore: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    }),
    success: Schema.Array(SmsCode),
    failure: OrchestratorMcpFailure,
    dependencies: [Invocation.McpInvocationContext, Threads.ThreadManagementService],
  }).annotate(Tool.Readonly, true),
);

export const handlers = Access.toLayer(toolkit, {
  sms_codes_read: Access.readsAsCaller(({ notBefore }) =>
    Effect.gen(function* () {
      const inbox = yield* Effect.serviceOption(SmsCodes.SmsCodes);
      if (Option.isNone(inbox))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "SMS inbox is unavailable in this environment.",
        });
      return yield* inbox.value.read(notBefore);
    }),
  ),
});
