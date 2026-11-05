import {
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type EnvironmentId,
} from "@t3tools/contracts";
import { runAttachmentUploadCycle } from "@t3tools/client-runtime/state/attachments";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { randomUUID } from "../../lib/utils";
import type { WorkTaskDraft } from "../../state/workPageState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { attachmentEnvironment } from "../../state/attachments";
import { readPreparedConnection } from "../../state/session";
import { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";

export function TaskDescription({
  environmentId,
  task,
  update,
  setError,
}: {
  environmentId: EnvironmentId;
  task: WorkTaskDraft;
  update: (change: (draft: WorkTaskDraft) => WorkTaskDraft) => void;
  setError: (error: string | null) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1.5 text-sm">
        Description
        <Textarea
          maxLength={20_000}
          value={task.notes}
          placeholder="Décris la tâche et colle tes images ici…"
          onChange={(event) => {
            const notes = event.target.value;
            update((draft) => ({ ...draft, notes }));
          }}
          onPaste={async (event) => {
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (!files.length) return;
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            const input = event.currentTarget;
            const notes =
              task.notes.slice(0, input.selectionStart) +
              text +
              task.notes.slice(input.selectionEnd);
            const images = files.map((file) => ({
              type: "image" as const,
              id: ChatAttachmentId.make(`pending-${randomUUID()}`),
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
            }));
            setError(null);
            const limitError = getProviderAttachmentLimitError([
              ...(task.attachments ?? []),
              ...images,
            ]);
            if (limitError || notes.length > 20_000 || task.pendingImages?.length) {
              setError(
                limitError ??
                  (notes.length > 20_000
                    ? "La description dépasse 20 000 caractères."
                    : "Attends la fin du collage en cours."),
              );
              return;
            }
            update((draft) => ({
              ...draft,
              notes,
              pendingImages: images.map(({ id, name }) => ({ id, name })),
            }));
            try {
              for (const [index, file] of files.entries()) {
                const pending = images[index]!;
                const mimeType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
                  (type) => type === file.type,
                );
                if (!mimeType || !file.size || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
                  throw new Error("Colle une image PNG, JPEG, GIF ou WebP de 10 Mo maximum.");
                }
                const result = await runAttachmentUploadCycle({
                  registry: appAtomRegistry,
                  createUploadUrl: attachmentEnvironment.createUploadUrl,
                  remove: attachmentEnvironment.remove,
                  environmentId,
                  upload: { name: file.name, mimeType, sizeBytes: file.size },
                  resolveUploadUrl: (url) => {
                    const connection = readPreparedConnection(environmentId);
                    return connection ? resolveAssetUrl(connection.httpBaseUrl, url) : null;
                  },
                  transport: (url) => {
                    const controller = new AbortController();
                    return {
                      abort: () => controller.abort(),
                      done: fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": mimeType },
                        body: file,
                        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
                      }).then((response) => {
                        if (!response.ok)
                          throw new Error("Impossible de conserver l’image. Colle-la à nouveau.");
                      }),
                    };
                  },
                });
                if (result.status !== "uploaded")
                  throw new Error("Impossible de conserver l’image. Colle-la à nouveau.");
                const image = {
                  type: "image" as const,
                  id: ChatAttachmentId.make(result.attachmentId),
                  name: file.name,
                  mimeType,
                  sizeBytes: file.size,
                };
                update((draft) =>
                  draft.pendingImages?.some((item) => item.id === pending.id)
                    ? {
                        ...draft,
                        attachments: [...(draft.attachments ?? []), image],
                        pendingImages: draft.pendingImages.filter((item) => item.id !== pending.id),
                      }
                    : draft,
                );
              }
            } catch (error) {
              setError(String(error));
              update((draft) => ({
                ...draft,
                pendingImages:
                  draft.pendingImages?.map((image) => ({
                    ...image,
                    error: "Image non enregistrée : retire-la puis colle-la à nouveau.",
                  })) ?? [],
              }));
            }
          }}
        />
      </label>
      {task.pendingImages?.map((image) => (
        <div key={image.id} className="flex flex-wrap items-center gap-2 text-sm" role="status">
          <span>{image.error ?? `En attente de l’image ${image.name}…`}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              update((draft) => ({
                ...draft,
                pendingImages: draft.pendingImages?.filter((item) => item.id !== image.id) ?? [],
              }))
            }
          >
            Retirer {image.name}
          </Button>
        </div>
      ))}
      {task.attachments?.map((image) => (
        <div key={image.id} className="space-y-1">
          <ChatMarkdownAssetImage
            environmentId={environmentId}
            resource={{ _tag: "attachment", attachmentId: image.id }}
            alt={image.name}
            maxHeightRem={12}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              update((draft) => ({
                ...draft,
                attachments: draft.attachments?.filter((item) => item.id !== image.id) ?? [],
              }))
            }
          >
            Retirer l’image {image.name}
          </Button>
        </div>
      ))}
    </div>
  );
}
