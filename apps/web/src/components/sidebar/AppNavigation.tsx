import { Link, useLocation } from "@tanstack/react-router";
import { HomeIcon, ListTodoIcon, SettingsIcon, ChartNoAxesColumnIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const destinations = [
  { to: "/", label: "Discussions", Icon: HomeIcon },
  { to: "/tasks", label: "Tâches", Icon: ListTodoIcon },
  { to: "/usage", label: "Usage", Icon: ChartNoAxesColumnIcon },
  { to: "/settings", label: "Réglages", Icon: SettingsIcon },
] as const;

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
            ? !["/tasks", "/usage", "/settings", "/pull-requests", "/status"].some(
                (path) => pathname === path || pathname.startsWith(`${path}/`),
              )
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
                  <Icon className="size-5" />
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
