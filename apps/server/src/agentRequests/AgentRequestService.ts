import {
  AgentRequest,
  AgentRequestError,
  type AgentRequestComplete,
  type AgentRequestCreate,
  type AgentRequestUpdate,
  type AgentRequestRespond,
  type ThreadId,
  type ChefRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as RuntimeAdmission from "../maintenance/RuntimeAdmission.ts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import * as RequestEffects from "./RequestEffects.ts";
import { requestSources } from "./requestSources.ts";

export class AgentRequestService extends Context.Service<
  AgentRequestService,
  {
    readonly changes: Stream.Stream<number>;
    readonly list: () => Effect.Effect<ReadonlyArray<AgentRequest>, AgentRequestError>;
    readonly subscribe: () => Stream.Stream<ReadonlyArray<AgentRequest>, AgentRequestError>;
    readonly create: (
      threadId: ThreadId,
      input: AgentRequestCreate,
    ) => Effect.Effect<AgentRequest, AgentRequestError>;
    readonly createChef: (
      threadId: ThreadId,
      input: AgentRequestCreate,
      chef: ChefRequest,
    ) => Effect.Effect<AgentRequest, AgentRequestError>;
    readonly updateChef: (
      threadId: ThreadId,
      input: AgentRequestUpdate,
      chef: ChefRequest,
    ) => Effect.Effect<AgentRequest, AgentRequestError>;
    readonly completeChef: (input: {
      id: string;
      expectedVersion: number;
      succeeded: boolean;
      summary: string;
    }) => Effect.Effect<AgentRequest, AgentRequestError>;
    readonly update: (
      threadId: ThreadId,
      input: AgentRequestUpdate,
    ) => Effect.Effect<AgentRequest, AgentRequestError>;
    readonly respond: (
      input: AgentRequestRespond,
    ) => Effect.Effect<AgentRequest, AgentRequestError>;
    readonly complete: (
      threadId: ThreadId,
      input: AgentRequestComplete,
    ) => Effect.Effect<AgentRequest, AgentRequestError>;
    readonly retryDelivery: (input: {
      id: string;
      expectedVersion: number;
    }) => Effect.Effect<void, AgentRequestError>;
    readonly drain: () => Effect.Effect<void, AgentRequestError>;
  }
>()("t3/agentRequests/AgentRequestService") {}

const isRequestError = Schema.is(AgentRequestError);
const requestCodec = Schema.fromJsonString(AgentRequest);
const decode = Schema.decodeUnknownEffect(requestCodec);
const encode = Schema.encodeEffect(requestCodec);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effects = yield* RequestEffects.RequestEffects;
  const drainLock = yield* Semaphore.make(1);
  const revision = yield* SubscriptionRef.make(0);
  const storage = () => new AgentRequestError({ reason: "storage" });
  const normalize = (cause: unknown) => (isRequestError(cause) ? cause : storage());
  const changed = SubscriptionRef.update(revision, (n) => n + 1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const sourcesFor = (id: string | null) =>
    requestSources(id).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(storage),
    );
  const list = () =>
    sql<{
      payload_json: string;
      agent_name: string | null;
      trigger: string | null;
      channel: string | null;
    }>`
      SELECT q.payload_json, json_extract(a.payload_json, '$.name') AS agent_name,
        json_extract(a.payload_json, '$.trigger') AS trigger,
        (SELECT json_extract(s.payload_json, '$.channelName') FROM work_task_slack_messages s
          WHERE s.task_id = r.task_id ORDER BY s.rowid LIMIT 1) AS channel
      FROM agent_requests q
      LEFT JOIN autonomous_agent_runs r ON r.thread_id = json_extract(q.payload_json, '$.threadId')
      LEFT JOIN autonomous_agents a ON a.id = r.agent_id
      ORDER BY q.rowid ASC`.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decode(row.payload_json).pipe(
            Effect.map((request) =>
              row.agent_name
                ? {
                    ...request,
                    autonomousAgent: {
                      name: row.agent_name,
                      qualifier: row.trigger === "unqualified",
                      source: row.channel ? `Slack - #${row.channel.replace(/^#/, "")}` : null,
                    },
                  }
                : request,
            ),
          ),
        ),
      ),
      Effect.flatMap((requests) =>
        sourcesFor(null).pipe(
          Effect.map((sources) =>
            requests.map((request) => {
              const source = sources.get(request.id);
              return source ? { ...request, source } : request;
            }),
          ),
        ),
      ),
      Effect.mapError(storage),
    );
  const get = (id: string) =>
    sql<{ payload_json: string }>`SELECT payload_json FROM agent_requests WHERE id = ${id}`.pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? decode(rows[0].payload_json).pipe(Effect.mapError(storage))
          : Effect.fail(new AgentRequestError({ reason: "conflict" })),
      ),
      Effect.mapError(normalize),
    );
  const put = (request: AgentRequest) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO agent_requests (id, payload_json) VALUES (${request.id}, ${yield* encode(request)}) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`;
      return request;
    }).pipe(Effect.mapError(storage));
  const putWithSource = Effect.fnUntraced(function* (request: AgentRequest) {
    yield* put(request);
    if (request.source !== undefined) return request;
    const source = (yield* sourcesFor(request.id)).get(request.id);
    if (!source && request.sourceTaskId) return yield* new AgentRequestError({ reason: "invalid" });
    return source ? yield* put({ ...request, source }) : request;
  });
  const mutate = <A>(body: Effect.Effect<A, AgentRequestError>) =>
    sql.withTransaction(body).pipe(
      Effect.mapError(normalize),
      Effect.tap(() => changed),
    );
  const check = (request: AgentRequest, version: number) =>
    request.version === version
      ? Effect.void
      : Effect.fail(new AgentRequestError({ reason: "conflict" }));
  const create = (threadId: ThreadId, input: AgentRequestCreate, chef?: ChefRequest) =>
    mutate(
      Effect.gen(function* () {
        const existing = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM agent_requests WHERE id = ${input.id}`.pipe(
          Effect.mapError(storage),
        );
        if (existing[0]) {
          const previous = yield* decode(existing[0].payload_json).pipe(Effect.mapError(storage));
          if (previous.threadId !== threadId)
            return yield* new AgentRequestError({ reason: "conflict" });
          return previous;
        }
        if (input.kind === "text" && input.action !== null)
          return yield* new AgentRequestError({ reason: "invalid" });
        if (chef && (input.kind !== "approval" || input.action !== null))
          return yield* new AgentRequestError({ reason: "invalid" });
        const at = yield* now;
        return yield* putWithSource({
          ...input,
          ...(chef ? { chef } : {}),
          threadId,
          version: 1,
          status: "pending",
          response: "",
          history: [],
          actionStatus: "idle",
          delivery: "none",
          createdAt: at,
          updatedAt: at,
        });
      }),
    );
  const update = (threadId: ThreadId, input: AgentRequestUpdate, chef?: ChefRequest) =>
    mutate(
      Effect.gen(function* () {
        const previous = yield* get(input.id);
        yield* check(previous, input.expectedVersion);
        if (Boolean(previous.chef) !== Boolean(chef) || (chef && input.action !== null))
          return yield* new AgentRequestError({ reason: "invalid" });
        if (
          previous.threadId !== threadId ||
          !["pending", "revision"].includes(previous.status) ||
          previous.delivery === "pending"
        )
          return yield* new AgentRequestError({ reason: "invalid" });
        if (input.kind === "text" && input.action !== null)
          return yield* new AgentRequestError({ reason: "invalid" });
        const { expectedVersion: _, withdraw, ...content } = input;
        const next = { ...previous, ...content, ...(chef ? { chef } : {}) };
        if (
          content.sourceTaskId !== undefined &&
          content.sourceTaskId !== previous.sourceTaskId &&
          content.source === undefined
        ) {
          delete next.source;
        }
        return yield* putWithSource({
          ...next,
          history: [
            ...previous.history,
            {
              at: previous.updatedAt,
              text: `${previous.context}\n${previous.question}\n${previous.details}`,
            },
          ],
          status: withdraw ? "withdrawn" : "pending",
          version: previous.version + 1,
          delivery: "none",
          updatedAt: yield* now,
        });
      }),
    );
  const respond = (input: AgentRequestRespond) =>
    mutate(
      Effect.gen(function* () {
        const previous = yield* get(input.id);
        yield* check(previous, input.expectedVersion);
        if (previous.status !== "pending")
          return yield* new AgentRequestError({ reason: "invalid" });
        if (input.remember && (input.decision !== "accept" || !previous.chef?.memory))
          return yield* new AgentRequestError({ reason: "invalid" });
        if (
          (input.decision === "accept" && previous.kind !== "approval") ||
          (input.decision === "answer" && previous.kind !== "text")
        ) {
          return yield* new AgentRequestError({ reason: "invalid" });
        }
        if ((input.decision === "answer" || input.decision === "revise") && !input.text.trim()) {
          return yield* new AgentRequestError({ reason: "invalid" });
        }
        const at = yield* now;
        const status = (
          {
            accept: "accepted",
            reject: "rejected",
            revise: "revision",
            answer: "answered",
            ignore: "ignored",
          } as const
        )[input.decision];
        return yield* put({
          ...previous,
          ...(previous.chef
            ? {
                chef: {
                  ...previous.chef,
                  remember: input.decision === "accept" && input.remember === true,
                },
              }
            : {}),
          version: previous.version + 1,
          status,
          response: input.decision === "ignore" ? "" : input.text,
          history: [
            ...previous.history,
            { at, text: input.decision === "ignore" ? "ignored" : `${status} : ${input.text}` },
          ],
          delivery: previous.chef || input.decision === "ignore" ? "none" : "pending",
          updatedAt: at,
        });
      }),
    );
  const complete = (threadId: ThreadId, input: AgentRequestComplete) =>
    mutate(
      Effect.gen(function* () {
        const previous = yield* get(input.id);
        yield* check(previous, input.expectedVersion);
        if (
          previous.threadId !== threadId ||
          previous.status !== "accepted" ||
          previous.action?.kind !== "agent" ||
          previous.actionStatus !== "idle" ||
          previous.delivery !== "sent"
        )
          return yield* new AgentRequestError({ reason: "invalid" });
        const at = yield* now;
        return yield* put({
          ...previous,
          actionStatus: input.succeeded ? "succeeded" : "failed",
          version: previous.version + 1,
          updatedAt: at,
          history: [...previous.history, { at, text: input.summary }],
        });
      }),
    );
  const completeChef: AgentRequestService["Service"]["completeChef"] = (input) =>
    mutate(
      Effect.gen(function* () {
        const previous = yield* get(input.id);
        yield* check(previous, input.expectedVersion);
        if (!previous.chef || previous.status !== "accepted" || previous.actionStatus !== "idle")
          return yield* new AgentRequestError({ reason: "invalid" });
        return yield* put({
          ...previous,
          actionStatus: input.succeeded ? "succeeded" : "failed",
          version: previous.version + 1,
          updatedAt: yield* now,
          history: [...previous.history, { at: yield* now, text: input.summary }],
        });
      }),
    );
  const retryDelivery = (input: { id: string; expectedVersion: number }) =>
    mutate(
      Effect.gen(function* () {
        const previous = yield* get(input.id);
        yield* check(previous, input.expectedVersion);
        if (previous.delivery !== "failed")
          return yield* new AgentRequestError({ reason: "invalid" });
        yield* put({ ...previous, delivery: "pending" });
      }),
    );
  // Claim an action durably before executing. A crash leaves uncertainty, never an automatic replay.
  const drain = () =>
    drainLock.withPermit(
      Effect.gen(function* () {
        for (const candidate of yield* list()) {
          if (candidate.delivery !== "pending") continue;
          let request = yield* get(candidate.id);
          if (
            request.status === "accepted" &&
            request.action?.kind === "command" &&
            request.actionStatus === "idle"
          ) {
            const claimed = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const current = yield* get(request.id);
                  if (current.actionStatus !== "idle") return false;
                  yield* put({ ...current, actionStatus: "running" });
                  return true;
                }),
              )
              .pipe(Effect.mapError(normalize));
            if (!claimed) continue;
            yield* changed;
            const succeeded = yield* effects.execute(request);
            request = { ...request, actionStatus: succeeded ? "succeeded" : "failed" };
            yield* put(request);
          }
          const delivered = yield* effects
            .notify(request)
            .pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
          yield* put({ ...request, delivery: delivered ? "sent" : "failed" });
          yield* changed;
        }
      }),
    );
  for (const request of yield* list()) {
    if (request.actionStatus === "running")
      yield* put({ ...request, actionStatus: "uncertain", delivery: "pending" });
  }
  return AgentRequestService.of({
    changes: SubscriptionRef.changes(revision),
    list,
    subscribe: () => SubscriptionRef.changes(revision).pipe(Stream.mapEffect(list)),
    create,
    update,
    createChef: (threadId, input, chef) => create(threadId, input, chef),
    updateChef: (threadId, input, chef) => update(threadId, input, chef),
    completeChef,
    respond,
    complete,
    retryDelivery,
    drain,
  });
});
export const layer = Layer.effect(AgentRequestService, make);
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* AgentRequestService;
    const admission = yield* Effect.serviceOption(RuntimeAdmission.RuntimeAdmission);
    const process = Effect.gen(function* () {
      if (Option.isSome(admission)) yield* admission.value.awaitOpen;
      yield* RuntimeAdmission.admit(service.drain());
    }).pipe(Effect.catch(() => Effect.logWarning("Request processing failed")));
    yield* service.changes.pipe(
      Stream.runForEach(() => process),
      Effect.forkScoped,
    );
  }),
);
