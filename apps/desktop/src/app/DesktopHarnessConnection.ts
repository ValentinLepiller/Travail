import { BearerConnectionRegistration } from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
} from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

class HarnessKeyringUnavailableError extends Schema.TaggedError<HarnessKeyringUnavailableError>()(
  "HarnessKeyringUnavailableError",
  {},
) {
  override get message() {
    return "Travail cannot protect its connection: unlock your keyring and relaunch.";
  }
}

const catalogJson = Schema.fromJsonString(ConnectionCatalogDocument);
const registrationJson = Schema.fromJsonString(BearerConnectionRegistration);
const decodeCatalog = Schema.decodeEffect(catalogJson);
const encodeCatalog = Schema.encodeEffect(catalogJson);
const decodeRegistration = Schema.decodeEffect(registrationJson);

// The launcher hands over a private credential; only Electron can encrypt the
// durable catalog with the user's keyring. Never leave the handoff after import.
export const importHarnessConnection = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const file = environment.path.join(environment.stateDir, "harness-connection.private.json");
  const raw = yield* fs
    .readFileString(file)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
      ),
    );
  if (raw === null) return;
  const registration = yield* decodeRegistration(raw);
  const existing = yield* store.get;
  const document = Option.isSome(existing)
    ? yield* decodeCatalog(existing.value)
    : EMPTY_CONNECTION_CATALOG_DOCUMENT;
  const next = registerConnectionInCatalog(document, registration);
  const encoded = yield* encodeCatalog(next);
  if (!(yield* store.set(encoded))) {
    return yield* new HarnessKeyringUnavailableError();
  }
  yield* fs.remove(file);
});
