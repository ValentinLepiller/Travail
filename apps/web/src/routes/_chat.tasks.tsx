import { createFileRoute } from "@tanstack/react-router";
import { WorkTasksPage } from "../components/workTasks/WorkTasksPage";

export const Route = createFileRoute("/_chat/tasks")({ component: WorkTasksPage });
