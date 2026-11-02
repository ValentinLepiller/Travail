import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import ChatMarkdown, { type ChatMarkdownContextReference } from "../ChatMarkdown";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { useFindRevealRef } from "./markdownFindContext";
import { shouldCollapseUserMessage } from "./MessagesTimeline.logic";

const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;
const EMPTY_SKILLS = [] as const;

export const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  searchExpanded?: boolean;
  text: string;
  renderContextReference?: (reference: ChatMarkdownContextReference) => ReactNode;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (props.searchExpanded) setExpanded(true);
  }, [props.searchExpanded]);
  // Find opens the body only when it selects a match in the clipped part.
  const revealForFind = useCallback(() => setExpanded(true), []);
  const findRevealRef = useFindRevealRef(revealForFind);
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;
  const showCollapseControl = canCollapse;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          ref={findRevealRef}
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <ChatMarkdown
            text={props.text}
            cwd={props.markdownCwd}
            threadRef={props.threadRef}
            renderContextReference={props.renderContextReference}
            skills={props.skills ?? EMPTY_SKILLS}
            className="text-foreground"
            lineBreaks
            parseRawHtml={false}
            headingLevelOffset={3}
          />
        </div>
      ) : null}
      {showCollapseControl || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            showCollapseControl && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {showCollapseControl ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
