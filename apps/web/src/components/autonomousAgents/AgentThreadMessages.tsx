import type { AutonomousAgentDetail, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import ChatMarkdown from "../ChatMarkdown";
import { CollapsibleUserMessageBody } from "../chat/CollapsibleUserMessageBody";
import { MessageCopyButton } from "../chat/MessageCopyButton";

export function AgentThreadMessages({
  messages,
  environmentId,
  threadId,
  agentName,
}: {
  messages: AutonomousAgentDetail["messages"];
  environmentId: EnvironmentId;
  threadId: ThreadId | undefined;
  agentName: string;
}) {
  const threadRef = threadId ? { environmentId, threadId } : undefined;
  return (
    <div aria-label="Messages du thread" className="space-y-5">
      {messages.map((message) => {
        const isUser = message.role === "user";
        const author = isUser ? "Consigne" : message.role === "assistant" ? agentName : "Système";
        return (
          <article key={message.id} className="group min-w-0">
            <h3 className="sr-only">{author}</h3>
            {isUser ? (
              <div className="ml-auto max-w-[95%] rounded-2xl bg-message p-3 text-message-foreground">
                <CollapsibleUserMessageBody
                  text={message.text}
                  markdownCwd={undefined}
                  threadRef={threadRef}
                />
              </div>
            ) : (
              <div className="min-w-0 px-1 py-0.5">
                <ChatMarkdown
                  text={message.text}
                  cwd={undefined}
                  environmentId={environmentId}
                  threadRef={threadRef}
                  lineBreaks={shouldPreserveAssistantLineBreaks(message.text)}
                  headingLevelOffset={3}
                />
              </div>
            )}
            <div
              className={`mt-1 flex items-center gap-1 text-xs text-muted-foreground ${isUser ? "justify-end" : "px-1"}`}
            >
              <span>{author}</span>
              <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                <MessageCopyButton text={message.text} label="Copier le message" variant="ghost" />
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
