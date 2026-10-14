import * as Schema from "effect/Schema";

export class RuntimeAdmissionError extends Schema.TaggedError<RuntimeAdmissionError>()(
  "RuntimeAdmissionError",
  {
    code: Schema.Literals([
      "maintenance_active",
      "busy",
      "operation_conflict",
      "hooks_missing",
      "invalid_probe",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Runtime admission: ${this.code}. ${this.detail}`;
  }
}
