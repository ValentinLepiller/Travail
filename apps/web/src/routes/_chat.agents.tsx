import { createFileRoute } from "@tanstack/react-router";
import { AutonomousAgentsPage } from "../components/autonomousAgents/AutonomousAgentsPage";
export const Route = createFileRoute("/_chat/agents")({ component: AutonomousAgentsPage });
