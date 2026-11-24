import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";

export const taskLaunchCommandId = (threadId: ThreadId) =>
  CommandId.make(`task-launch:${threadId}`);

export const admissionMessagePrefix = "chantier-admission:";
export const admissionMessageId = (threadId: ThreadId) =>
  MessageId.make(`${admissionMessagePrefix}${threadId}`);
