import { Link, useLocation } from "@tanstack/react-router";
import {
  BotIcon,
  HomeIcon,
  InboxIcon,
  ListTodoIcon,
  SettingsIcon,
  ChartNoAxesColumnIcon,
} from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentSelection } from "../../hooks/useEnvironmentSelection";
import { useEnvironmentQuery } from "../../state/query";
import { agentRequests } from "../../state/agentRequests";
import { useSidebar } from "../ui/sidebar";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const destinations = [
  { to: "/", label: "Discussions", Icon: HomeIcon },
  { to: "/requests", label: "Requêtes", Icon: InboxIcon },
  { to: "/tasks", label: "Tâches", Icon: ListTodoIcon },
  { to: "/agents", label: "Auto", Icon: BotIcon },
  { to: "/usage", label: "Usage", Icon: ChartNoAxesColumnIcon },
  { to: "/settings", label: "Réglages", Icon: SettingsIcon },
] as const;

function RequestCount({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(agentRequests({ environmentId, input: {} }));
  const count = query.data?.filter((request) => request.status === "pending").length ?? 0;
  if (count === 0) return null;
  return (
    <span
      className="absolute -right-3 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold leading-none text-primary-foreground"
      aria-label={`${count} requête${count > 1 ? "s" : ""} en attente`}
    >
      {count}
    </span>
  );
}

function RequestBadge() {
  const { environmentId } = useEnvironmentSelection();
  return environmentId ? <RequestCount environmentId={environmentId} /> : null;
}

function NavigationIcon({ to, Icon }: Pick<(typeof destinations)[number], "to" | "Icon">) {
  return (
    <span className="relative">
      <Icon className="size-5" />
      {to === "/requests" && <RequestBadge />}
    </span>
  );
}

export function AppNavigation() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <nav
      aria-label="Navigation principale"
      className="fixed inset-y-0 left-0 z-40 hidden w-16 flex-col items-center gap-3 border-r border-sidebar-border bg-sidebar py-12 md:flex"
    >
      {destinations.map(({ to, label, Icon }) => {
        const active =
          to === "/"
            ? ![
                "/agents",
                "/requests",
                "/tasks",
                "/usage",
                "/settings",
                "/pull-requests",
                "/status",
              ].some((path) => pathname === path || pathname.startsWith(`${path}/`))
            : pathname === to || pathname.startsWith(`${to}/`);
        return (
          <Tooltip key={to}>
            <TooltipTrigger
              render={
                <Link
                  to={to}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex w-14 flex-col items-center gap-1 rounded-lg py-2 text-3xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    active
                      ? "bg-primary/15 text-primary"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                  )}
                >
                  <NavigationIcon to={to} Icon={Icon} />
                  <span>{label}</span>
                </Link>
              }
            />
            <TooltipPopup side="right">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </nav>
  );
}

export function MobileAppNavigation() {
  const { setOpenMobile } = useSidebar();
  return (
    <nav
      aria-label="Navigation principale"
      className="relative z-10 shrink-0 border-b border-sidebar-border px-3 py-2 md:hidden"
    >
      <div className="grid grid-cols-4 gap-1">
        {destinations.slice(0, 4).map(({ to, label, Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: to === "/" }}
            activeProps={{ className: "bg-primary/15 text-primary", "aria-current": "page" }}
            inactiveProps={{ className: "text-sidebar-foreground/70 hover:bg-sidebar-row-hover" }}
            onClick={() => setOpenMobile(false)}
            className="flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <NavigationIcon to={to} Icon={Icon} />
            <span>{label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
