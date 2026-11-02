import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Source from "./SlackTaskSource.ts";

const input = {
  workspaceId: "TTEST",
  after: "1793278000.000000",
  before: "1793278060.000000",
  cursor: null,
};
const command = (code: string) => ({
  executable: process.execPath,
  args: ["-e", code],
  cwd: process.cwd(),
  codexHome: "/tmp/slack-test-profile",
});
const layer = Source.layer.pipe(Layer.provide(NodeServices.layer));

it.effect("passes the collection window to the process and decodes its page", () =>
  Effect.gen(function* () {
    const source = yield* Source.SlackTaskSource;
    const page = yield* source.readPage(
      command(`
      let text = ''; process.stdin.on('data', chunk => text += chunk);
      process.stdin.on('end', () => {
        const input = JSON.parse(text);
        if (input.workspaceId !== 'TTEST' || input.after !== '1793278000.000000') process.exit(2);
        console.log(JSON.stringify({ messages: [], nextCursor: null }));
      });
    `),
      input,
    );
    expect(page).toEqual({ messages: [], nextCursor: null });
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects failed or malformed collector output", () =>
  Effect.gen(function* () {
    const source = yield* Source.SlackTaskSource;
    for (const code of [
      "console.log('{}')",
      'console.log(\'{"messages":[],"nextCursor":null}\'); process.exit(2)',
    ]) {
      expect((yield* source.readPage(command(code), input).pipe(Effect.flip)).stage).toBe("source");
    }
  }).pipe(Effect.provide(layer)),
);
