import * as Schema from "effect/Schema";

export const TravailUpdateRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
export const TravailUpdateStatus = Schema.Struct({
  installed: Schema.NullOr(TravailUpdateRevision),
  available: Schema.NullOr(TravailUpdateRevision),
  installing: Schema.Boolean,
  failed: Schema.Boolean,
});
export type TravailUpdateStatus = typeof TravailUpdateStatus.Type;

export const TravailUpdateRequest = Schema.Struct({ revision: TravailUpdateRevision });
export type TravailUpdateRequest = typeof TravailUpdateRequest.Type;
