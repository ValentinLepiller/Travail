import { createFileRoute } from "@tanstack/react-router";
import { AgentRequestsPage } from "../components/agentRequests/AgentRequestsPage";
export const Route = createFileRoute("/_chat/requests")({ component: AgentRequestsPage });
