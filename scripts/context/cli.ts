// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Read-only agent command line.
import * as NodeUtil from "node:util";
import { readHistory, readMemory, searchHistory, searchMemory } from "./local.ts";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    limit: { type: "string", default: "5" },
    start: { type: "string", default: "1" },
  },
});
try {
  const [command, input] = positionals;
  if (!input)
    throw new Error(
      "Usage: node scripts/context/cli.ts memory-search|memory-read|history-search|history-read query-or-relative-path [--home path] [--limit n] [--start n]",
    );
  const limit = Number(values.limit);
  const home = values.home;
  let result;
  switch (command) {
    case "memory-search":
      result = await searchMemory(input, limit, home);
      break;
    case "memory-read":
      result = await readMemory(input, Number(values.start), limit, home);
      break;
    case "history-search":
      result = await searchHistory(input, limit, home);
      break;
    case "history-read":
      result = await readHistory(input, limit, home);
      break;
    default:
      throw new Error("Unknown context command");
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local context unavailable");
  process.exitCode = 1;
}
