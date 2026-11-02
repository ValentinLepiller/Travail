import collectorScript from "../../../../server/scripts/collect-gmail-tasks.ts?raw";
import collectorService from "../../../../server/src/workTasks/GmailTaskCollector.ts?raw";
import { CollectionAutomationDetail } from "./CollectionAutomationDetail";

const sources = {
  script: { path: "apps/server/scripts/collect-gmail-tasks.ts", code: collectorScript },
  service: { path: "apps/server/src/workTasks/GmailTaskCollector.ts", code: collectorService },
};

export default function GmailAutomationDetail({ onClose }: { onClose: () => void }) {
  return <CollectionAutomationDetail name="Gmail" sources={sources} onClose={onClose} />;
}
