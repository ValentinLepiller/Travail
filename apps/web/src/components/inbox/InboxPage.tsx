import { SubjectActions } from "./SubjectActions";
import { InboxCard } from "./InboxCard";
import {
  useCallback,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  type CSSProperties,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { LayersIcon, MailIcon } from "lucide-react";
import type { EnvironmentId, InboxMessage, InboxSubjectActionResult } from "@t3tools/contracts";
import { useEnvironmentSelection } from "../../hooks/useEnvironmentSelection";
import { useInboxSubjects, useInboxSubjectEntries } from "../../state/inboxSubjects";
import { useInboxMessages } from "../../state/inbox";
import { isElectron } from "../../env";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import gmailLogo from "../../assets/inbox/gmail.svg";
import slackLogo from "../../assets/inbox/slack.svg";

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });
const sourceLogos = { gmail: gmailLogo, slack: slackLogo };
const endReachedThreshold = 0.5;
const pendingLabels = { error: "À réessayer", processing: "En cours" };

const categories = {
  no_action: { label: "Sans action", color: "#34d399" },
  information: { label: "Information", color: "#60a5fa" },
  personal_action: { label: "Personnel", color: "#c084fc" },
  technical_action: { label: "Technique", color: "#fb923c" },
  unsure: { label: "Incertain", color: "#facc15" },
};

function QualificationBadge({ entry }: { entry: InboxMessage }) {
  const category = entry.qualification ? categories[entry.qualification.category] : null;
  const attempt = entry.qualificationAttempt;
  const label = category?.label ?? (attempt ? pendingLabels[attempt.status] : "À examiner");
  return (
    <Badge
      variant="label"
      shape="pill"
      size="sm"
      style={{ "--label": category?.color ?? "#94a3b8" } as CSSProperties}
      title={
        category
          ? "Qualification Jev indicative"
          : attempt?.status === "error"
            ? `Qualification en erreur (${attempt.error}) · reprise en attente`
            : "Qualification Jev en attente"
      }
    >
      {label}
    </Badge>
  );
}

function InboxDate({ date, label }: { date: Date; label?: string }) {
  const valid = !Number.isNaN(date.getTime());
  const formatted = valid ? dateFormat.format(date) : "Date inconnue";
  return (
    <time
      className="text-2xs text-muted-foreground"
      aria-label={label ? `${label} : ${formatted}` : undefined}
      dateTime={valid ? date.toISOString() : undefined}
    >
      {formatted}
    </time>
  );
}

function Message({
  entry,
  open,
  onOpenChange,
  embedded = false,
}: {
  entry: InboxMessage;
  open: boolean;
  onOpenChange: (id: string, open: boolean) => void;
  embedded?: boolean;
}) {
  const { source } = entry;
  const date = new Date(
    Number(source.kind === "gmail" ? source.message.receivedAt : source.message.ts) * 1000,
  );
  const title =
    source.kind === "gmail"
      ? source.message.subject || "Sans objet"
      : source.message.text || "Message Slack";
  const author =
    source.kind === "gmail"
      ? source.message.sender
      : source.message.authorName || source.message.authorId;
  const origin =
    source.kind === "gmail"
      ? author
      : `#${source.message.channelName.replace(/^#/, "")} · ${author}`;
  return (
    <InboxCard
      open={open}
      onOpenChange={(value) => onOpenChange(entry.id, value)}
      embedded={embedded}
      icon={
        <img
          src={sourceLogos[source.kind]}
          alt={source.kind === "gmail" ? "Gmail" : "Slack"}
          className={embedded ? "size-5" : "size-6"}
        />
      }
      heading={
        <>
          <span className="truncate text-xs text-muted-foreground">{origin}</span>
          <span className="block truncate text-sm font-medium">{title.slice(0, 240)}</span>
        </>
      }
      aside={
        <>
          <QualificationBadge entry={entry} />
          <InboxDate date={date} />
        </>
      }
    >
      <p className="whitespace-pre-wrap break-words text-sm">
        {source.message.text || "Message sans texte."}
      </p>
      <a
        className="mt-3 inline-block text-sm text-primary underline underline-offset-4"
        href={entry.url}
        target="_blank"
        rel="noreferrer"
      >
        Ouvrir dans {source.kind === "gmail" ? "Gmail" : "Slack"}
      </a>
      <section aria-label="Contexte antérieur" className="mt-3 rounded-xl bg-muted/50 px-3 py-2.5">
        <h2 className="text-xs font-medium text-muted-foreground">Contexte antérieur</h2>
        {!entry.context ? (
          <p className="text-xs text-muted-foreground">Contexte non récupéré.</p>
        ) : (
          <>
            {entry.context.status !== "ready" ? (
              <p className="text-xs text-muted-foreground">
                {entry.context.status === "partial"
                  ? "Contexte incomplet."
                  : "Contexte indisponible."}
              </p>
            ) : entry.context.messages.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun message antérieur.</p>
            ) : null}
            {entry.context.truncated ? (
              <p className="text-xs text-muted-foreground">Contexte limité.</p>
            ) : null}
            {entry.context.messages.map((previous) => {
              const message = previous.message;
              const timestamp =
                previous.kind === "gmail" ? previous.message.receivedAt : previous.message.ts;
              const date = new Date(Number(timestamp) * 1000);
              const author =
                previous.kind === "gmail"
                  ? previous.message.sender
                  : previous.message.authorName || previous.message.authorId;
              return (
                <div
                  key={previous.kind === "gmail" ? previous.message.id : previous.message.ts}
                  className="mt-3"
                >
                  <p className="text-xs text-muted-foreground">
                    {author} ·{" "}
                    {Number.isNaN(date.getTime()) ? "Date inconnue" : dateFormat.format(date)}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
                </div>
              );
            })}
          </>
        )}
      </section>
    </InboxCard>
  );
}

function ListStatus({
  query,
  count,
  emptyMessage,
}: {
  query: Pick<ReturnType<typeof useInboxMessages>, "error" | "isPending" | "retry">;
  count: number;
  emptyMessage: string;
}) {
  if (query.error)
    return (
      <div className="py-4">
        <p role="alert" className="mb-2 text-sm text-destructive">
          {query.error}
        </p>
        <Button variant="outline" size="sm" disabled={query.isPending} onClick={query.retry}>
          Réessayer
        </Button>
      </div>
    );
  if (query.isPending)
    return (
      <p role="status" className="py-4 text-sm text-muted-foreground">
        Chargement…
      </p>
    );
  if (count === 0) return <p className="py-8 text-sm text-muted-foreground">{emptyMessage}</p>;
  return null;
}

function InfiniteList<Item extends { id: string }>({
  items,
  loadNext,
  renderItem,
  extraData,
  footer,
}: {
  items: ReadonlyArray<Item>;
  loadNext: () => void;
  renderItem: (item: Item) => ReactNode;
  extraData?: unknown;
  footer: ReactElement;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const measureFrame = useRef<number | null>(null);
  const measuredPage = useRef({ items, loadNext });
  // LegendList retains its initial layout callback, so read the latest committed page through a ref.
  const fillViewport = useCallback(() => {
    if (measureFrame.current !== null) return;
    // The edge callback stays latched until new rows put the end beyond its threshold.
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = null;
      const page = measuredPage.current;
      const state = listRef.current?.getState();
      if (
        state &&
        state.data === page.items &&
        state.scrollLength > 0 &&
        state.contentLength - state.scroll - state.scrollLength <=
          state.scrollLength * endReachedThreshold
      )
        page.loadNext();
    });
  }, []);
  useLayoutEffect(() => {
    measuredPage.current = { items, loadNext };
    fillViewport();
    return () => {
      if (measureFrame.current !== null) cancelAnimationFrame(measureFrame.current);
      measureFrame.current = null;
    };
  }, [fillViewport, loadNext, items]);
  return (
    <LegendList
      ref={listRef}
      data={items}
      keyExtractor={(item) => item.id}
      extraData={extraData}
      renderItem={({ item }) => renderItem(item)}
      estimatedItemSize={100}
      drawDistance={300}
      recycleItems={false}
      onEndReached={loadNext}
      onScroll={fillViewport}
      onLayout={fillViewport}
      onItemSizeChanged={fillViewport}
      onMetricsChange={fillViewport}
      onLoad={fillViewport}
      onEndReachedThreshold={endReachedThreshold}
      className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden"
      ListFooterComponent={footer}
    />
  );
}

function Messages({
  environmentId,
  onRefresh,
  processed,
}: {
  environmentId: EnvironmentId;
  onRefresh: () => void;
  processed: boolean;
}) {
  const query = useInboxMessages(environmentId, processed);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const onOpenChange = (id: string, open: boolean) =>
    setOpened((current) => {
      if (current.has(id) === open) return current;
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
        <p className="text-sm text-muted-foreground">Messages Gmail et Slack reçus.</p>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          Actualiser
        </Button>
      </div>
      <div className="min-h-0 flex-1" aria-busy={query.isPending}>
        <InfiniteList
          items={query.messages}
          loadNext={query.loadNext}
          extraData={opened}
          renderItem={(item) => (
            <Message entry={item} open={opened.has(item.id)} onOpenChange={onOpenChange} />
          )}
          footer={
            <ListStatus
              query={query}
              count={query.messages.length}
              emptyMessage={processed ? "Aucun message traité." : "Aucun message à traiter."}
            />
          }
        />
      </div>
    </>
  );
}

function SubjectEntries({
  environmentId,
  subjectId,
}: {
  environmentId: EnvironmentId;
  subjectId: string;
}) {
  const query = useInboxSubjectEntries(environmentId, subjectId);
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <div>
      {query.error ? <p role="alert">{query.error}</p> : null}
      {query.isPending ? <p role="status">Chargement…</p> : null}
      {query.data?.messages.map((entry) => (
        <Message
          key={entry.id}
          embedded
          entry={entry}
          open={opened === entry.id}
          onOpenChange={(id, open) =>
            setOpened((current) => (open ? id : current === id ? null : current))
          }
        />
      ))}
      {query.data?.nextCursor != null ? (
        <Button variant="outline" size="sm" onClick={() => query.setAfter(query.data!.nextCursor!)}>
          Entrées suivantes
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          query.setAfter(undefined);
          query.refresh();
        }}
      >
        Actualiser les entrées
      </Button>
    </div>
  );
}
function Subjects({
  environmentId,
  onRefresh,
  processed,
}: {
  environmentId: EnvironmentId;
  onRefresh: () => void;
  processed: boolean;
}) {
  const query = useInboxSubjects(environmentId, processed);
  const [decisions, setDecisions] = useState<Record<string, typeof InboxSubjectActionResult.Type>>(
    {},
  );
  const subjects = useMemo(
    () =>
      query.subjects
        .map((subject) =>
          decisions[subject.id] ? { ...subject, ...decisions[subject.id] } : subject,
        )
        .filter(
          (subject) =>
            (subject.closedAt
              ? true
              : (subject.processed ?? Boolean(subject.ignored || subject.taskId))) === processed,
        ),
    [query.subjects, decisions, processed],
  );
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
        <p className="text-sm text-muted-foreground">Sujets regroupant les messages liés.</p>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          Actualiser
        </Button>
      </div>
      <div className="min-h-0 flex-1" aria-busy={query.isPending}>
        <InfiniteList
          items={subjects}
          loadNext={query.loadNext}
          extraData={opened}
          renderItem={(subject) => (
            <InboxCard
              open={opened === subject.id}
              onOpenChange={(open) =>
                setOpened((current) =>
                  open ? subject.id : current === subject.id ? null : current,
                )
              }
              icon={<LayersIcon className="size-5" aria-hidden="true" />}
              heading={
                <>
                  <span className="truncate text-sm font-medium">{subject.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{subject.summary}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {subject.context
                      ? `${subject.context.kind === "project" ? "Projet" : subject.context.kind === "chantier" ? "Chantier" : "Tâche"} · ${subject.contextLabel ?? "Indisponible"}${subject.contextUncertain ? " · à confirmer" : ""}`
                      : subject.contextUpdatedAt
                        ? "Sans contexte identifié"
                        : subject.contextError
                          ? "Contexte indisponible"
                          : "Contexte à identifier"}
                  </span>
                </>
              }
              aside={
                <>
                  <Badge variant="secondary" size="sm" shape="pill">
                    {subject.entries} {subject.entries === 1 ? "message" : "messages"}
                  </Badge>
                  {subject.closedAt ? (
                    <Badge variant="secondary" size="sm">
                      Terminé
                    </Badge>
                  ) : subject.ignored ? (
                    <Badge variant="secondary" size="sm">
                      Ignoré
                    </Badge>
                  ) : null}
                  {subject.taskId ? (
                    <Badge variant="secondary" size="sm">
                      {subject.processed === false && !subject.closedAt
                        ? "À mettre à jour"
                        : "Tâche liée"}
                    </Badge>
                  ) : null}
                  <InboxDate date={new Date(subject.createdAt)} label="Date de création du sujet" />
                </>
              }
            >
              <p className="mb-2 text-sm text-muted-foreground">{subject.summary}</p>
              {subject.contextReason ? (
                <p className="mb-2 text-xs text-muted-foreground">{subject.contextReason}</p>
              ) : null}
              <SubjectActions
                environmentId={environmentId}
                subject={subject}
                onSaved={(result) =>
                  setDecisions((current) => ({ ...current, [result.subjectId]: result }))
                }
              />
              <SubjectEntries
                key={subject.id}
                environmentId={environmentId}
                subjectId={subject.id}
              />
            </InboxCard>
          )}

          footer={
            <ListStatus
              query={query}
              count={subjects.length}
              emptyMessage={processed ? "Aucun sujet traité." : "Aucun sujet à traiter."}
            />
          }
        />
      </div>
    </>
  );
}

export function InboxPage() {
  const selection = useEnvironmentSelection();
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<"messages" | "subjects">("messages");
  const [processed, setProcessed] = useState(false);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <MailIcon className="size-4" />
        <h1 className="text-sm font-medium">Inbox</h1>
      </WorkspacePageHeader>
      <main className="flex min-h-0 flex-1 flex-col px-4 py-4 sm:px-6">
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
          {selection.environments.length > 1 ? (
            <div className="mb-4">
              <select
                aria-label="Machine"
                value={selection.environmentId ?? ""}
                onChange={(event) =>
                  selection.setEnvironmentId(
                    selection.environments.find(
                      (entry) => entry.environmentId === event.target.value,
                    )?.environmentId ?? null,
                  )
                }
              >
                {selection.environments.map((entry) => (
                  <option key={entry.environmentId} value={entry.environmentId}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="mb-3 flex items-center justify-between gap-3">
            <div
              className="w-fit rounded-2xl border border-border bg-card/70 p-1"
              role="tablist"
              aria-label="Inbox"
            >
              <Button
                variant={view === "messages" ? "secondary" : "ghost"}
                size="sm"
                role="tab"
                aria-selected={view === "messages"}
                onClick={() => setView("messages")}
              >
                Messages
              </Button>
              <Button
                variant={view === "subjects" ? "secondary" : "ghost"}
                size="sm"
                role="tab"
                aria-selected={view === "subjects"}
                onClick={() => setView("subjects")}
              >
                Sujets
              </Button>
            </div>
            <Button
              variant={processed ? "secondary" : "outline"}
              size="sm"
              aria-pressed={processed}
              title={
                processed ? "Afficher les éléments à traiter" : "Afficher les éléments traités"
              }
              onClick={() => setProcessed((value) => !value)}
            >
              Traités
            </Button>
          </div>
          {selection.environmentId && view === "subjects" ? (
            <Subjects
              key={`${selection.environmentId}:${revision}:${processed}`}
              environmentId={selection.environmentId}
              processed={processed}
              onRefresh={() => setRevision((value) => value + 1)}
            />
          ) : selection.environmentId ? (
            <Messages
              key={`${selection.environmentId}:${revision}:${processed}`}
              environmentId={selection.environmentId}
              processed={processed}
              onRefresh={() => setRevision((value) => value + 1)}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Connectez une machine pour consulter l’inbox.
            </p>
          )}
        </div>
      </main>
    </SidebarInset>
  );
}
