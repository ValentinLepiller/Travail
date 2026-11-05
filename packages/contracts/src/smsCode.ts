import * as Schema from "effect/Schema";

export const SmsCodeDeposit = Schema.Struct({
  sender: Schema.String.check(Schema.isPattern(/^okta$/i)),
  code: Schema.String.check(Schema.isPattern(/^[0-9]{6}$/)),
  receivedAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
export type SmsCodeDeposit = typeof SmsCodeDeposit.Type;

export const SmsCode = Schema.Struct({
  ...SmsCodeDeposit.fields,
  expiresAt: Schema.Number,
});
export type SmsCode = typeof SmsCode.Type;

export class SmsCodeError extends Schema.TaggedError<SmsCodeError>()("SmsCodeError", {
  code: Schema.Literals(["unauthorized", "invalid_input", "expired"]),
}) {
  override get message() {
    return "SMS code request refused.";
  }
}
