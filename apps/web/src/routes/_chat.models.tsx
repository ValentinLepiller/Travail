import { createFileRoute } from "@tanstack/react-router";
import { WorkModelsPage } from "../components/workTasks/WorkModelsPage";

export const Route = createFileRoute("/_chat/models")({ component: WorkModelsPage });
