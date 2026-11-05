import { createFileRoute } from "@tanstack/react-router";
import { ChefsPage } from "../components/chefs/ChefsPage";
export const Route = createFileRoute("/_chat/chefs")({ component: ChefsPage });
