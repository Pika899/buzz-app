import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import type { JsonValue } from "../navigation/targets";
import type { RelayEvent } from "../relay/events";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";

export type AgentSessionSource = Readonly<{
  channelId: string;
  root?: string;
}>;

export type AgentSessionAdmission = Readonly<{
  agent: AgentKey;
  owner: string;
  harness: string;
  source: AgentSessionSource;
  /** The native conversation scope. It can include several source threads. */
  conversation: AgentSessionSource;
  invocationId: string;
  event?: RelayEvent;
  sessionKey: string;
  intent: "new" | "existing";
  resumed: boolean;
  /** The host adopts a source lifetime with no saved logical association. */
  adopted: boolean;
  association?: JsonValue;
  signal: AbortSignal;
}>;

export type AgentSessionAssociation = Readonly<{
  sessionKey: string;
  router: string;
  association: JsonValue;
}>;

type AdmissionRequest = Omit<
  AgentSessionAdmission,
  "sessionKey" | "intent" | "association" | "adopted"
>;
export type AgentSessionRouter = Readonly<{
  id: string;
  /** Opens local keyed storage. This must not wait for a sidebar or relay. */
  ready(): Promise<void>;
  matches(
    input: Pick<
      AgentSessionAdmission,
      "agent" | "owner" | "harness" | "source"
    >,
  ): boolean;
  route?(
    input: Omit<AdmissionRequest, "conversation"> &
      Readonly<{ defaultConversation: AgentSessionSource }>,
  ): "source-thread" | undefined | Promise<"source-thread" | undefined>;
  /** Saves the local association before returning. Undefined leaves the run unchanged. */
  prepare(input: AgentSessionAdmission): Promise<
    | Readonly<{
        association: JsonValue;
        context?: string;
      }>
    | undefined
  >;
}>;

export const SESSION_ADMISSION_PREFIX = "buzz.agents.session-admission.v1:";
type Pointer = Readonly<{
  sessionKey: string;
  adopted?: true;
  resetting?: true;
}>;
type Saved = AgentSessionAssociation &
  Readonly<{
    context?: string;
    conversation?: AgentSessionSource;
    contextAcknowledged?: true;
  }>;

function parse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("The saved agent session association is invalid");
  }
}

const keyFor = (agent: AgentKey, harness: string, source: AgentSessionSource) =>
  SESSION_ADMISSION_PREFIX +
  JSON.stringify([
    "source",
    agent,
    harness,
    source.channelId,
    source.root ?? null,
  ]);
type Route = Readonly<{
  associated?: true;
  router: string;
  conversation: AgentSessionSource;
}>;
const routeKey = (
  agent: AgentKey,
  harness: string,
  source: AgentSessionSource,
) =>
  SESSION_ADMISSION_PREFIX +
  JSON.stringify([
    "route",
    agent,
    harness,
    source.channelId,
    source.root ?? null,
  ]);
const savedKey = (sessionKey: string) =>
  SESSION_ADMISSION_PREFIX + JSON.stringify(["session", sessionKey]);

/** Logical lifetimes survive harness reconnects. Each invocation keeps its own key. */
export function createSessionAdmissions(root: Context, storage: AgentStore) {
  const routers = createContributions<AgentSessionRouter>(root);
  const pending = new Map<string, Promise<Saved | undefined>>();
  let stopped = false;
  root.effect(() => () => {
    stopped = true;
  });
  const check = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (stopped) throw new Error("Agent session admission is stopped");
  };
  return {
    conversation(agent: AgentKey, harness: string, source: AgentSessionSource) {
      const text = storage.get(routeKey(agent, harness, source));
      return text === null ? undefined : parse<Route>(text).conversation;
    },
    register(ctx: Context, router: AgentSessionRouter) {
      if (
        !ctx.pluginOwner ||
        !/^[a-z0-9][a-z0-9._-]*$/.test(router.id) ||
        typeof router.ready !== "function" ||
        typeof router.matches !== "function" ||
        typeof router.prepare !== "function" ||
        (router.route !== undefined && typeof router.route !== "function")
      )
        throw new Error(
          "A session router needs an id, ready, matches and prepare",
        );
      routers.register(ctx, router);
    },
    async resolve(request: AdmissionRequest) {
      check(request.signal);
      const sourceKey = routeKey(
        request.agent,
        request.harness,
        request.source,
      );
      if (!routers.snapshot().length && storage.get(sourceKey) === null) return;
      let input = request;
      const candidates = routers.snapshot();
      await Promise.all(candidates.map((router) => router.ready()));
      check(input.signal);
      const routeText = await storage.read(sourceKey);
      const priorRoute =
        routeText === null ? undefined : parse<Route>(routeText);
      const matches = candidates.filter((router) =>
        priorRoute ? router.key === priorRoute.router : router.matches(input),
      );
      if (matches.length > 1)
        throw new Error("More than one plugin routes this agent session");
      const router = matches[0];
      if (!router && !priorRoute) return;
      const invocationKey =
        SESSION_ADMISSION_PREFIX +
        JSON.stringify([
          "invocation",
          input.agent,
          input.harness,
          input.invocationId,
        ]);
      const invocation = await storage.read(invocationKey);
      const priorSessionText =
        invocation === null
          ? null
          : await storage.read(savedKey(parse<string>(invocation)));
      const priorSession =
        priorSessionText === null ? undefined : parse<Saved>(priorSessionText);
      let conversation =
        priorSession?.conversation ??
        priorRoute?.conversation ??
        input.conversation;
      if (invocation === null && !priorRoute && router?.route) {
        const { conversation: defaultConversation, ...beforeRoute } = input;
        const choice = await router.route({
          ...beforeRoute,
          defaultConversation,
        });
        check(input.signal);
        if (choice !== undefined && choice !== "source-thread")
          throw new Error("Unsupported agent session route");
        if (choice === "source-thread") {
          if (
            !input.source.root ||
            !/^[0-9a-f]{64}$/i.test(input.source.root) ||
            input.source.channelId !== input.conversation.channelId
          )
            throw new Error(
              "A source-thread route needs a verified root in the same channel",
            );
          conversation = input.source;
        }
      }
      const routerKey = priorRoute?.router ?? router?.key;
      if (!routerKey)
        throw new Error("The agent session router is unavailable");
      const selected: Route = priorRoute ?? {
        router: routerKey,
        conversation,
      };
      const heldRoute = parse<Route>(
        await storage.add(sourceKey, JSON.stringify(selected)),
      );
      conversation =
        invocation !== null && priorSession && !priorSession.conversation
          ? request.conversation
          : (priorSession?.conversation ?? heldRoute.conversation);
      if (
        conversation.channelId !== input.source.channelId ||
        (conversation.root !== undefined &&
          conversation.root !== input.source.root)
      )
        throw new Error("The saved agent route does not match its source");
      input = { ...input, conversation };
      const prepareAdmission = async (signal: AbortSignal) => {
        input = { ...request, conversation, signal };
        check(signal);
        const pointerKey = keyFor(input.agent, input.harness, conversation);
        const firstKey = JSON.stringify([
          input.agent,
          input.harness,
          input.invocationId,
        ]);
        const pointer = parse<Pointer>(
          await storage.add(
            pointerKey,
            JSON.stringify({
              sessionKey: firstKey,
              ...(conversation.root !== request.conversation.root
                ? {}
                : { adopted: true }),
            }),
          ),
        );
        if (!pointer.sessionKey || pointer.resetting)
          throw new Error(
            "The agent session reset is incomplete. Use New again before sending a message.",
          );
        const sessionKey = parse<string>(
          await storage.add(invocationKey, JSON.stringify(pointer.sessionKey)),
        );
        if (
          typeof sessionKey !== "string" ||
          !sessionKey ||
          sessionKey.length > 1024
        )
          throw new Error("The saved agent session key is invalid");
        if (sessionKey !== pointer.sessionKey)
          throw new Error(
            "This request belongs to an earlier session. Send a new message to continue.",
          );
        const prepare = async () => {
          const text = await storage.read(savedKey(sessionKey));
          const prior = text === null ? undefined : parse<Saved>(text);
          if (
            prior &&
            (prior.sessionKey !== sessionKey ||
              prior.router !== heldRoute.router)
          )
            throw new Error("The agent session belongs to another router");
          check(input.signal);
          if (!router) {
            if (!prior)
              throw new Error("The agent session router is unavailable");
            return prior;
          }
          const result = await router.prepare({
            ...input,
            sessionKey,
            intent: prior || pointer.adopted ? "existing" : "new",
            adopted: !prior && !!pointer.adopted,
            ...(prior
              ? { association: structuredClone(prior.association) }
              : {}),
          });
          check(input.signal);
          if (!routers.snapshot().includes(router))
            throw new Error("The agent session router changed");
          if (!result) {
            if (prior || priorRoute?.associated)
              throw new Error(
                "The plugin cannot restore this agent session association",
              );
            return;
          }
          if (
            result.context !== undefined &&
            typeof result.context !== "string"
          )
            throw new Error("Agent session context must be text");
          const association = JSON.stringify(result.association);
          if (
            association === undefined ||
            (prior && association !== JSON.stringify(prior.association))
          )
            throw new Error("The agent session association cannot change");
          if (prior) return prior;
          const saved: Saved = {
            sessionKey,
            router: router.key,
            conversation,
            association: result.association,
            ...(result.context ? { context: result.context } : {}),
          };
          return parse<Saved>(
            await storage.add(savedKey(sessionKey), JSON.stringify(saved)),
          );
        };
        const active = pending.get(sessionKey) ?? prepare();
        pending.set(sessionKey, active);
        let saved: Saved | undefined;
        try {
          saved = await active;
        } finally {
          if (pending.get(sessionKey) === active) pending.delete(sessionKey);
        }
        check(input.signal);
        if (!saved) {
          if (!priorRoute?.associated) {
            await storage.set(sourceKey, null);
            await storage.set(invocationKey, null);
          }
          return;
        }
        if (!heldRoute.associated)
          await storage.set(
            sourceKey,
            JSON.stringify({ ...heldRoute, associated: true }),
          );
        let acknowledged = !!saved.contextAcknowledged;
        return Object.freeze({
          acknowledged: () => {
            if (acknowledged || !saved?.context) return;
            acknowledged = true;
            void storage
              .set(
                savedKey(saved.sessionKey),
                JSON.stringify({ ...saved, contextAcknowledged: true }),
              )
              .catch((error) =>
                console.error(
                  `Agent ${input.agent} session ${sessionKey} context acknowledgement was not saved`,
                  error,
                ),
              );
          },
          session: Object.freeze({
            sessionKey: saved.sessionKey,
            router: saved.router,
            association: structuredClone(saved.association),
          }),
          ...(!saved.contextAcknowledged && saved.context
            ? { context: saved.context }
            : {}),
        });
      };
      return Object.freeze({ conversation, prepare: prepareAdmission });
    },
    async reset(
      agent: AgentKey,
      harness: string,
      source: AgentSessionSource,
      run: () => Promise<void>,
    ) {
      const key = keyFor(agent, harness, source);
      if (!routers.snapshot().length && storage.get(key) === null) return run();
      const text = await storage.read(key);
      if (text === null) return run();
      const prior = parse<Pointer>(text);
      const sessionKey = prior.resetting
        ? prior.sessionKey
        : crypto.randomUUID();
      await storage.set(key, JSON.stringify({ sessionKey, resetting: true }));
      await run();
      await storage.set(key, JSON.stringify({ sessionKey }));
    },
  };
}
