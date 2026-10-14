import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RuntimeAdmission from "../maintenance/RuntimeAdmission.ts";

import { AgentDesktopRuntime, type AgentDesktopConfiguration } from "./AgentDesktopRuntime.ts";
import {
  AgentDesktopError,
  isAgentDesktopError,
  type AgentDesktopApplication,
  type AgentDesktopController,
  type AgentDesktopInput,
  type AgentDesktopSnapshot,
  type AgentDesktopStatus,
  type AgentDesktopTarget,
  type AgentDesktopLease,
} from "@t3tools/contracts";

export class AgentDesktops extends Context.Service<
  AgentDesktops,
  {
    readonly activeCount: Effect.Effect<number>;
    readonly list: (
      namespace: string,
    ) => Effect.Effect<readonly AgentDesktopLease[], AgentDesktopError>;
    readonly acquire: (
      namespace: string,
      leaseId?: string,
    ) => Effect.Effect<{ leaseId: string; status: AgentDesktopStatus }, AgentDesktopError>;
    readonly ensure: (ownerId: string) => Effect.Effect<AgentDesktopStatus, AgentDesktopError>;
    readonly status: (ownerId: string) => Effect.Effect<AgentDesktopStatus, AgentDesktopError>;
    readonly launch: (
      ownerId: string,
      application: AgentDesktopApplication,
      target: AgentDesktopTarget,
      message?: string,
    ) => Effect.Effect<AgentDesktopStatus, AgentDesktopError>;
    readonly capture: (ownerId: string) => Effect.Effect<AgentDesktopSnapshot, AgentDesktopError>;
    readonly input: (
      ownerId: string,
      actor: AgentDesktopController,
      input: AgentDesktopInput,
    ) => Effect.Effect<AgentDesktopStatus, AgentDesktopError>;
    /** Transports derive ownerId/actor from authenticated context, never agent parameters. */
    readonly transfer: (
      ownerId: string,
      target: AgentDesktopTarget,
      controller: AgentDesktopController,
    ) => Effect.Effect<AgentDesktopStatus, AgentDesktopError>;
    readonly close: (
      ownerId: string,
      actor?: AgentDesktopController,
      target?: AgentDesktopTarget,
    ) => Effect.Effect<void, AgentDesktopError>;
  }
>()("t3/agentDesktops/AgentDesktops") {}

const operation = <A>(name: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isAgentDesktopError(cause)
        ? cause
        : new AgentDesktopError({ code: "operation_failed", operation: name, cause }),
  });

const make = (configuration: AgentDesktopConfiguration) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new AgentDesktopRuntime(configuration),
        catch: (cause) =>
          new AgentDesktopError({ code: "unavailable", operation: "initialize", cause }),
      }),
      (value) => Effect.promise(() => value.dispose()).pipe(Effect.orDie),
    );
    const admission = yield* Effect.serviceOption(RuntimeAdmission.RuntimeAdmission);
    if (Option.isSome(admission)) yield* admission.value.registerHook("desktops");
    const admitted = <A>(name: string, effect: Effect.Effect<A, AgentDesktopError>) =>
      Option.isNone(admission)
        ? effect
        : admission.value
            .admit(effect)
            .pipe(
              Effect.mapError((cause) =>
                isAgentDesktopError(cause)
                  ? cause
                  : new AgentDesktopError({ code: "maintenance_active", operation: name, cause }),
              ),
            );
    return AgentDesktops.of({
      activeCount: Effect.sync(() => runtime.activeCount()),
      list: (namespace) => operation("list", () => runtime.list(namespace)),
      acquire: (namespace, leaseId) =>
        admitted(
          "acquire",
          operation("acquire", () => runtime.acquire(namespace, leaseId)),
        ),
      ensure: (owner) =>
        admitted(
          "open",
          operation("open", () => runtime.ensure(owner)),
        ),
      status: (owner) => operation("status", () => runtime.status(owner)),
      launch: (owner, app, target, message) =>
        admitted(
          "launch",
          operation("launch", () => runtime.launch(owner, app, target, message)),
        ),
      capture: (owner) => operation("capture", () => runtime.capture(owner)),
      input: (owner, actor, input) =>
        admitted(
          "input",
          operation("input", () => runtime.input(owner, actor, input)),
        ),
      transfer: (owner, target, controller) =>
        admitted(
          "transfer",
          operation("transfer", () => runtime.transfer(owner, target, controller)),
        ),
      close: (owner, actor, target) =>
        operation("close", () => runtime.close(owner, actor, target)),
    });
  });

export const layer = (configuration: AgentDesktopConfiguration) =>
  Layer.effect(AgentDesktops, make(configuration));
