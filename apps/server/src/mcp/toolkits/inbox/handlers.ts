import * as Subjects from "../../../inbox/InboxSubjectService.ts";
import * as Qualifications from "../../../inbox/InboxQualificationService.ts";
import * as Contexts from "../../../inbox/InboxContextService.ts";
import * as Effect from "effect/Effect";
import * as Inbox from "../../../inbox/MessageInbox.ts";
import * as Access from "../../McpToolAccess.ts";
import { InboxToolkit } from "./tools.ts";
import * as Chef from "../../../globalChef/GlobalChefService.ts";
import { ChefError } from "@t3tools/contracts";
import { readCaller } from "../../threadAccess.ts";

export const layer = Access.toLayer(InboxToolkit, {
  chef_status: Access.reads(() => Effect.flatMap(Chef.GlobalChefService, (s) => s.status())),
  chef_dossiers: Access.reads((input) =>
    Effect.flatMap(Chef.GlobalChefService, (s) => s.list(input)),
  ),
  chef_dossier_read: Access.reads((input) =>
    Effect.flatMap(Chef.GlobalChefService, (s) => s.read(input)),
  ),
  chef_memory: Access.reads((input) =>
    Effect.flatMap(Chef.GlobalChefService, (s) => s.memory(input)),
  ),
  chef_control: Access.writes((input) =>
    Effect.gen(function* () {
      const chef = yield* Chef.GlobalChefService;
      yield* chef.command({ type: "configure", ...input });
      return yield* chef.status();
    }),
  ),
  chef_dossier_reply: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      if (!caller) return yield* new ChefError({ reason: "missing" });
      return yield* (yield* Chef.GlobalChefService).reply(caller.id, input);
    }),
  ),
  inbox_subjects: Access.reads((input) =>
    Effect.flatMap(Subjects.InboxSubjectService, (s) => s.list(input)),
  ),
  inbox_subject_entries: Access.reads((input) =>
    Effect.flatMap(Subjects.InboxSubjectService, (s) => s.entries(input)),
  ),
  inbox_grouping_status: Access.reads(() =>
    Effect.flatMap(Subjects.InboxSubjectService, (s) => s.status()),
  ),
  inbox_grouping_control: Access.writes((input) =>
    Effect.flatMap(Subjects.InboxSubjectService, (s) => s.setEnabled(input.enabled)),
  ),

  inbox_qualification_status: Access.reads(() =>
    Effect.flatMap(Qualifications.InboxQualificationService, (s) => s.status()),
  ),
  inbox_qualification_control: Access.writes((input) =>
    Effect.flatMap(Qualifications.InboxQualificationService, (s) => s.setEnabled(input.enabled)),
  ),
  inbox_context_backfill: Access.writes((input) =>
    Effect.flatMap(Contexts.InboxContextService, (service) => service.backfill(input)),
  ),
  inbox_list: Access.reads((input) =>
    Effect.flatMap(Inbox.MessageInbox, (service) => service.list(input)),
  ),
  inbox_read: Access.reads((input) =>
    Effect.flatMap(Inbox.MessageInbox, (service) => service.read(input)),
  ),
});
