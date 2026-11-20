import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  resolveProjectProviderInstanceEnabled,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { createModelSelection, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { SlidersHorizontalIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { isElectron } from "../../env";
import { useEnvironmentSelection } from "../../hooks/useEnvironmentSelection";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { autonomousAgents, commandAutonomousAgent } from "../../state/autonomousAgents";
import { commandGlobalChef, globalChefStatus } from "../../state/globalChef";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";

const INHERIT = "inherit";
const modelKey = ({ instanceId, model }: ModelSelection) => JSON.stringify([instanceId, model]);

export function WorkModelsPage() {
  const { environmentId, environments, setEnvironmentId } = useEnvironmentSelection();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <SlidersHorizontalIcon className="size-4" />
        <h1 className="text-sm font-medium">Modèles</h1>
      </WorkspacePageHeader>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-5 sm:px-6">
          {environments.length > 1 && (
            <div className="max-w-xs">
              <Select
                value={environmentId}
                onValueChange={(value) => {
                  const environment = environments.find(
                    ({ environmentId }) => environmentId === value,
                  );
                  if (environment) setEnvironmentId(environment.environmentId);
                }}
              >
                <SelectTrigger aria-label="Machine">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}
          {environmentId ? (
            <WorkModelSettings key={environmentId} environmentId={environmentId} />
          ) : (
            <p className="text-muted-foreground">
              Connecte une machine pour accéder à ses modèles.
            </p>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function WorkModelSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const agents = useEnvironmentQuery(autonomousAgents({ environmentId, input: {} }));
  const schedules = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const canEditSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const globalChef = useEnvironmentQuery(globalChefStatus({ environmentId, input: {} }));
  const updateGlobalChef = useAtomCommand(commandGlobalChef);
  const canEditGlobalChef = useAtomValue(commandGlobalChef.permissionAtom(environmentId));
  const chefSettings = globalChef.data?.settings;
  const canEditAgents = useAtomValue(commandAutonomousAgent.permissionAtom(environmentId));
  const canEditSchedules = useAtomValue(
    serverEnvironment.setScheduledTaskModel.permissionAtom(environmentId),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const updateAgent = useAtomCommand(commandAutonomousAgent);
  const updateSchedule = useAtomCommand(serverEnvironment.setScheduledTaskModel);
  const saveSettings = (patch: ServerSettingsPatch) =>
    updateSettings({ environmentId, input: { patch } });
  const providerEnabled = (id: ServerProvider["instanceId"], projectId?: ProjectId | null) =>
    resolveProjectProviderInstanceEnabled(settings, projectId ?? null, id);
  const machineProviders = providers.filter(({ instanceId }) => providerEnabled(instanceId));
  const automaticModel = resolveDefaultProviderModelSelection(machineProviders, null);

  return (
    <>
      <ModelSection title="Modèles par défaut">
        <ModelRow
          label="Machine"
          detail="Modèle hérité par les projets."
          selection={settings.defaultModelSelection}
          fallback={automaticModel ? `Automatique · ${automaticModel.model}` : "Automatique"}
          providers={machineProviders}
          disabled={!canEditSettings}
          onSave={(value) => saveSettings({ defaultModelSelection: value })}
        />
        {projects.map((project) => {
          const { overrides } = resolveProjectSettings(settings, project.id, project);
          const { defaultModelSelection: selection, ...otherOverrides } = overrides;
          const projectProviders = providers.filter(({ instanceId }) =>
            providerEnabled(instanceId, project.id),
          );
          const inherited = resolveDefaultProviderModelSelection(
            projectProviders,
            settings.defaultModelSelection,
          );
          return (
            <ModelRow
              key={project.id}
              label={project.title}
              detail={
                projects.some((other) => other.id !== project.id && other.title === project.title)
                  ? project.workspaceRoot
                  : undefined
              }
              selection={selection ?? null}
              fallback={inherited ? `Hérité · ${inherited.model}` : "Hérité de la machine"}
              providers={projectProviders}
              disabled={!canEditSettings}
              onSave={(value) =>
                saveSettings({
                  projectSettingsOverrides: {
                    [project.id]: value
                      ? { ...otherOverrides, defaultModelSelection: value }
                      : otherOverrides,
                  },
                })
              }
            />
          );
        })}
      </ModelSection>

      <ModelSection title="Chefs et agents autonomes">
        {chefSettings && (
          <ModelRow
            label="Le Chef"
            detail={chefSettings.enabled ? undefined : "En pause"}
            selection={chefSettings.modelSelection}
            {...(chefSettings.enabled ? {} : { fallback: "Aucun modèle" })}
            providers={providers.filter(({ instanceId }) =>
              providerEnabled(instanceId, chefSettings.projectId),
            )}
            disabled={!canEditGlobalChef}
            onSave={async (modelSelection) => {
              const result = await updateGlobalChef({
                environmentId,
                input: {
                  type: "configure",
                  projectId: chefSettings.projectId,
                  enabled: chefSettings.enabled,
                  modelSelection,
                },
              });
              if (result._tag === "Success") globalChef.refresh();
            }}
          />
        )}
        <ModelRow
          label="Tâches lancées par les agents"
          detail="S’applique aux nouvelles discussions créées via le lancement natif d’une tâche Travail."
          selection={settings.workAgentModelSelection}
          fallback="Choisi par l’agent au lancement"
          providers={machineProviders}
          disabled={!canEditSettings}
          onSave={(value) => saveSettings({ workAgentModelSelection: value })}
        />
        {agents.data?.map((agent) => (
          <ModelRow
            key={agent.id}
            label={agent.name}
            detail={agent.paused ? "En pause" : undefined}
            selection={agent.modelSelection}
            providers={providers.filter(({ instanceId }) =>
              providerEnabled(instanceId, agent.projectId),
            )}
            disabled={!canEditAgents}
            onSave={(value) =>
              value &&
              updateAgent({
                environmentId,
                input: { type: "model", id: agent.id, modelSelection: value },
              })
            }
          />
        ))}
        {agents.error && (
          <p role="alert" className="text-sm text-destructive">
            {agents.error}
          </p>
        )}
      </ModelSection>

      <ModelSection title="Tâches planifiées">
        {schedules.data?.tasks.map((task) => (
          <ModelRow
            key={task.id}
            label={task.title}
            detail={task.enabled ? undefined : "En pause"}
            selection={task.modelSelection}
            providers={providers.filter(({ instanceId }) =>
              providerEnabled(instanceId, task.projectId),
            )}
            disabled={!canEditSchedules}
            onSave={(value) =>
              value &&
              updateSchedule({ environmentId, input: { id: task.id, modelSelection: value } })
            }
          />
        ))}
        {schedules.error && (
          <p role="alert" className="text-sm text-destructive">
            {schedules.error}
          </p>
        )}
        {schedules.isSuccess && schedules.data?.tasks.length === 0 && (
          <p className="text-sm text-muted-foreground">Aucune tâche planifiée.</p>
        )}
      </ModelSection>
    </>
  );
}

function ModelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="border-b pb-2 text-sm font-semibold">{title}</h2>
      <div className="divide-y">{children}</div>
    </section>
  );
}

function ModelRow({
  label,
  detail,
  selection,
  fallback,
  providers,
  disabled,
  onSave,
}: {
  label: string;
  detail?: string | undefined;
  selection: ModelSelection | null;
  fallback?: string;
  providers: readonly ServerProvider[];
  disabled: boolean;
  onSave: (value: ModelSelection | null) => Promise<unknown> | null;
}) {
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const selectedKey = selection ? modelKey(selection) : INHERIT;
  const options = providers
    .filter((provider) => provider.availability !== "unavailable" && provider.status === "ready")
    .flatMap((provider) =>
      provider.models.map((model) => {
        const value = { instanceId: provider.instanceId, model: model.slug };
        return {
          value,
          capabilities: model.capabilities,
          key: modelKey(value),
          label: `${model.name} · ${provider.displayName ?? provider.driver}`,
        };
      }),
    );
  const selectedLabel =
    options.find((option) => option.key === selectedKey)?.label ?? selection?.model ?? fallback;
  const effort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">{label}</p>
        {detail && <p className="break-words text-xs text-muted-foreground">{detail}</p>}
      </div>
      <div>
        <Select
          value={selectedKey}
          disabled={disabled || saving || options.length === 0}
          onValueChange={async (key) => {
            if (key === selectedKey || pending.current) return;
            const next = options.find((option) => option.key === key);
            if (!next && (key !== INHERIT || !fallback)) return;
            pending.current = true;
            setSaving(true);
            try {
              if (!next) {
                await onSave(null);
                return;
              }
              const options =
                selection?.instanceId === next.value.instanceId
                  ? selection.options?.filter(({ id, value }) =>
                      next.capabilities?.optionDescriptors?.some(
                        (descriptor) =>
                          descriptor.id === id &&
                          (descriptor.type === "boolean"
                            ? typeof value === "boolean"
                            : descriptor.options.some((choice) => choice.id === value)),
                      ),
                    )
                  : undefined;
              await onSave(createModelSelection(next.value.instanceId, next.value.model, options));
            } finally {
              pending.current = false;
              setSaving(false);
            }
          }}
        >
          <SelectTrigger aria-label={`Modèle · ${label}`}>
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {fallback && <SelectItem value={INHERIT}>{fallback}</SelectItem>}
            {options.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {typeof effort === "string" && (
          <p className="mt-1 text-xs text-muted-foreground">Effort · {effort}</p>
        )}
      </div>
    </div>
  );
}
