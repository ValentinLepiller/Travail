import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";

export const taskImageTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-task-images-",
}).pipe(Layer.provideMerge(NodeServices.layer));
