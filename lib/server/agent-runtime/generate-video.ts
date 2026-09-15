import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssetStore } from '@openmaic/storage';
import { nanoid } from 'nanoid';
import { Type, type Static } from 'typebox';

import { generateVideo, normalizeVideoOptions, VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
  VideoProviderId,
} from '@/lib/media/types';
import {
  enabledProviderIds,
  getServerVideoProviders,
  isServerProviderDisabled,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
} from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  DownloadByteBudget,
  MAX_REMOTE_IMAGE_BATCH_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  readResponseBodyWithLimit,
} from '@/lib/server/bounded-download';
import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import {
  AssetStorageFullError,
  storeGeneratedAssetOrThrow,
} from '@/lib/server/store-generated-asset';
import {
  HOST_AGENT_LIFECYCLE as LIFECYCLE,
  type MediaReadyLifecycleData,
} from '@/lib/agent-runtime/lifecycle';
import type { Scene } from '@/lib/types/stage';
import type { CourseStore, CourseToolDeps } from './course-tools';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import { errorResult, MEDIA_TOOL_ERROR_REASONS } from './media-tool-result';
import { runStageMutation } from './mutation-fence';
import { registerPendingMedia, setPendingMediaStage, settlePendingMedia } from './pending-media';
import { getAgentSessionStore } from './store';

const log = createLogger('AgentGenerateVideo');

export const GENERATE_VIDEO_TOOL_NAME = 'generate_video';
// The longest provider poll budget is 15 minutes.
export const GENERATE_VIDEO_TIMEOUT_MS = 15 * 60_000;
/** The completion patch is a handful of document writes; a minute is ample. */
export const GENERATE_VIDEO_PATCH_TIMEOUT_MS = 60_000;
export const MAX_GENERATED_VIDEO_BYTES = 200 * 1024 * 1024;

export const GenerateVideoParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  prompt: Type.String({
    minLength: 1,
    description: 'A concrete visual and motion description of the video to create.',
  }),
  aspectRatio: Type.Optional(
    Type.Union(
      [
        Type.Literal('16:9'),
        Type.Literal('4:3'),
        Type.Literal('1:1'),
        Type.Literal('9:16'),
        Type.Literal('3:4'),
        Type.Literal('21:9'),
      ],
      { description: 'Requested output aspect ratio. Provider capabilities may normalize it.' },
    ),
  ),
  durationSec: Type.Optional(
    Type.Number({
      minimum: 1,
      description: 'Requested duration in seconds. Provider capabilities may normalize it.',
    }),
  ),
  resolution: Type.Optional(
    Type.Union([Type.Literal('480p'), Type.Literal('720p'), Type.Literal('1080p')], {
      description: 'Requested output resolution. Provider capabilities may normalize it.',
    }),
  ),
});

type GenerateConfiguredVideo = (
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
) => Promise<VideoGenerationResult>;

interface PersistVideoInput {
  result: VideoGenerationResult;
  stageId: string;
  signal: AbortSignal;
}

interface PersistedVideo {
  /** The allocated asset id for the video bytes. */
  src: string;
  mime: string;
  /**
   * The allocated asset id for the provider's poster image, when it offered
   * one and storing it succeeded. Absent otherwise: a poster is an
   * optimization, and losing it must never cost the video.
   */
  poster?: string;
}

type PersistGeneratedVideo = (input: PersistVideoInput) => Promise<PersistedVideo>;

/** The stored ids the completion patch writes onto the element. */
type PersistedMedia = Pick<PersistedVideo, 'src' | 'poster'>;

/**
 * Whether a document value is an id the asset pool allocated.
 *
 * A plain boolean rather than the imported type predicate: narrowing a value
 * already known to be a string to `string` leaves `never` on the other branch,
 * and the checks after this one still have work to do on it.
 */
function isAllocatedAssetId(value: string): boolean {
  return mayNameAPoolAsset(value);
}

export interface GenerateVideoToolDeps extends Pick<CourseToolDeps, 'sessionId' | 'abortSignal'> {
  /**
   * The document store for the detached background job's completion patch.
   * It must be owner-bound but NOT fenced by the run lease: the job
   * legitimately writes minutes after its run ended, when the lease is
   * already released, so the runner wires a dedicated lease-free store here.
   * Passing the shared run-fenced `store` would throw
   * AgentSessionLeaseLostError on every post-run patch. Without it the job
   * still generates and emits, but skips the patch.
   */
  backgroundStore?: CourseStore;
  getConfiguredVideoProviders?: () => Record<string, { models?: string[]; disabled?: boolean }>;
  resolveVideoProviderConfig?: (providerId: VideoProviderId) => VideoGenerationConfig;
  generateConfiguredVideo?: GenerateConfiguredVideo;
  persistGeneratedVideo?: PersistGeneratedVideo;
  /**
   * Completion channel for the background job. Defaults to appending the
   * `media_ready` lifecycle event to the session's durable log through the
   * session-level control channel (valid post-run, unlike the runner's
   * lease-guarded `emit`).
   */
  emitMediaReady?: (sessionId: string, data: MediaReadyLifecycleData) => Promise<void> | void;
  timeoutMs?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

function isTimeout(signal: AbortSignal): boolean {
  return (
    signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
  );
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** SSRF-guarded, redirect-following fetch for a provider's video or poster. */
async function fetchGeneratedMedia(url: string, signal: AbortSignal): Promise<Response> {
  const maxRedirects = 5;
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    throwIfAborted(signal);
    const ssrfError = await validateUrlForSSRF(currentUrl);
    throwIfAborted(signal);
    if (ssrfError) throw new Error(ssrfError);

    const response = await fetch(currentUrl, { redirect: 'manual', signal });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) throw new Error('Video download redirect has no Location header');
    if (hop >= maxRedirects) throw new Error('Video download exceeded 5 redirects');
    currentUrl = new URL(location, currentUrl).href;
  }
}

/**
 * Download the provider's poster and store it, or give up on it.
 *
 * A poster is a convenience the provider may or may not offer, so every
 * failure here — a bad URL, a download error, a full store — costs the poster
 * and nothing else. The video is the deliverable, and it is already stored by
 * the time this runs.
 */
async function storeGeneratedPoster(
  posterUrl: string,
  stageId: string,
  signal: AbortSignal,
  assetStore?: AssetStore,
): Promise<string | undefined> {
  try {
    const response = await fetchGeneratedMedia(posterUrl, signal);
    if (!response.ok) throw new Error(`Generated poster download failed: HTTP ${response.status}`);
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
    if (!mime.startsWith('image/')) {
      throw new Error(`Generated poster download returned unexpected content type: ${mime}`);
    }
    // A poster is a still frame, so the image caps apply to it rather than the
    // video's.
    const bytes = await readResponseBodyWithLimit(response, {
      maxBytes: MAX_REMOTE_IMAGE_BYTES,
      aggregateBudget: new DownloadByteBudget(MAX_REMOTE_IMAGE_BATCH_BYTES),
    });
    throwIfAborted(signal);
    return await storeGeneratedAssetOrThrow({
      stageId,
      bytes,
      mimeType: mime,
      kind: 'poster',
      assetStore,
    });
  } catch (error) {
    log.warn(
      `Generated poster for stage ${stageId} was not stored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * Video providers return hosted URLs that may expire. Materialize those bytes
 * into the asset pool and return the ids it allocated.
 *
 * `src` is an `ast_` id rather than a serving path. The completion patch names
 * it (and the poster's id) on the video element, and that document write is
 * what commits both allocations and records their references (#1473). A video
 * the store has no room for fails the job: there is no local-disk fallback,
 * because a fallback would restore the two-model situation this path removes.
 *
 * `assetStore` is a test seam — the historical shape of this function before
 * #1242 replaced the pool with a local file.
 */
export async function defaultPersistGeneratedVideo(
  { result, stageId, signal }: PersistVideoInput,
  assetStore?: AssetStore,
): Promise<PersistedVideo> {
  throwIfAborted(signal);
  let parsed: URL;
  try {
    parsed = new URL(result.url);
  } catch {
    throw new Error('Video provider returned an invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Video provider returned an unsupported URL protocol: ${parsed.protocol}`);
  }

  const response = await fetchGeneratedMedia(result.url, signal);
  if (!response.ok) throw new Error(`Generated video download failed: HTTP ${response.status}`);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'video/mp4';
  if (!mime.startsWith('video/')) {
    throw new Error(`Generated video download returned unexpected content type: ${mime}`);
  }
  const bytes = await readResponseBodyWithLimit(response, { maxBytes: MAX_GENERATED_VIDEO_BYTES });
  throwIfAborted(signal);

  const src = await storeGeneratedAssetOrThrow({
    stageId,
    bytes,
    mimeType: mime,
    kind: 'video',
    assetStore,
  });
  throwIfAborted(signal);

  const poster = result.poster
    ? await storeGeneratedPoster(result.poster, stageId, signal, assetStore)
    : undefined;
  throwIfAborted(signal);
  return { src, mime, ...(poster ? { poster } : {}) };
}

/**
 * Enabled video provider ids from the listing: configured and not
 * force-disabled (#665). The gate and the selector both resolve enabledness
 * through {@link enabledProviderIds}, so an operator force-off is never
 * registered or selected.
 */
function configuredProviderIds(
  configured: Record<string, { models?: string[]; disabled?: boolean }>,
): VideoProviderId[] {
  return enabledProviderIds(configured).filter(
    (id): id is VideoProviderId => id in VIDEO_PROVIDERS,
  );
}

/** Server-side config resolution; the server `_MODELS` pin is authoritative. */
function defaultResolveVideoProviderConfig(providerId: VideoProviderId): VideoGenerationConfig {
  return {
    providerId,
    apiKey: resolveVideoApiKey(providerId),
    baseUrl: resolveVideoBaseUrl(providerId),
    model: resolveVideoModel(providerId),
  };
}

/** Capability gate used before the tool enters a session's registered toolset. */
export function hasConfiguredVideoGeneration(deps: Partial<GenerateVideoToolDeps> = {}): boolean {
  const getConfigured = deps.getConfiguredVideoProviders ?? getServerVideoProviders;
  const resolveConfig = deps.resolveVideoProviderConfig ?? defaultResolveVideoProviderConfig;
  return configuredProviderIds(getConfigured()).some((providerId) => {
    const provider = VIDEO_PROVIDERS[providerId];
    const config = resolveConfig(providerId);
    return !provider.requiresApiKey || !!config.apiKey;
  });
}

/**
 * Default completion channel: append `media_ready` to the session's durable
 * event log through the session-level control channel. This deliberately does
 * NOT go through the runner's `emit`: `appendRunEvent` is lease-guarded to a
 * live run, while the background job routinely settles after its run ended.
 * `appendControlEvent` writes the same log the SSE route replays and fires the
 * transactional NOTIFY that wakes attached streams.
 */
async function defaultEmitMediaReady(
  sessionId: string,
  data: MediaReadyLifecycleData,
): Promise<void> {
  const store = await getAgentSessionStore();
  const appended = await store.appendControlEvent(sessionId, {
    ts: Date.now(),
    type: LIFECYCLE.mediaReady,
    data,
  });
  // appendControlEvent resolves null when the session row is gone: the frame
  // is dropped silently by the store, so say so here.
  if (appended === null) {
    log.warn(`media_ready dropped for ${data.ref}: session ${sessionId} no longer exists`);
  }
}

/**
 * Emit one `media_ready` frame through the injected or default channel. A
 * failed emit must never take the detached job down as an unhandled
 * rejection; the registry entry and the document patch still stand.
 */
async function emitMediaReadyFrame(
  deps: GenerateVideoToolDeps,
  toolCallId: string,
  data: MediaReadyLifecycleData,
): Promise<void> {
  const sessionId = deps.sessionId;
  if (!sessionId) {
    log.warn(`[${toolCallId}] media_ready skipped: the tool has no session id`);
    return;
  }
  try {
    await (deps.emitMediaReady ?? defaultEmitMediaReady)(sessionId, data);
  } catch (error) {
    log.error(`[${toolCallId}] media_ready emit failed for ${data.ref}`, error);
  }
}

/**
 * Swap a video placeholder for the stored asset ids on the stored document:
 * every slide video element whose `mediaRef` or `src` still equals the
 * placeholder gets the allocated video id, and the poster id when there is
 * one. This `putScene` is also the write that commits both allocations and
 * records their rows in `document_asset_refs` — the store does that inside the
 * write's own transaction, so there is no reference bookkeeping here. Same
 * mutation discipline as the generation tools
 * (`runStageMutation` + putScene). When no element
 * references the placeholder anymore — the agent or the user changed or
 * removed it meanwhile — the patch is skipped silently; the completion event
 * still carries the src.
 *
 * Each candidate scene is re-read immediately before its write: the job runs
 * minutes after the tool call, exactly when the user or a resumed run may be
 * editing the same page, so the swap is always applied to the freshest scene
 * rather than the candidate-list snapshot. The residual read→write window
 * matches the stage edit API's own read-modify-write discipline.
 */
export async function patchStageVideoPlaceholder(
  store: CourseStore,
  stageId: string,
  ref: string,
  media: PersistedMedia,
  signal?: AbortSignal,
): Promise<number> {
  const doc = await store.loadDocument(stageId);
  if (!doc) return 0;
  // A previously generated src of THIS stage (regeneration: the agent
  // re-pointed mediaRef at a new job while the element still carries the
  // last generated video, which would otherwise keep rendering it). Both
  // the relative form the legacy local-disk flow wrote and the absolute form
  // the classic pipeline persists are recognized; scoped to the stage's own
  // media root so a user's pick copied from another stage is preserved.
  const generatedPrefix = `/api/classroom-media/${stageId}/`;
  const isReplaceableSrc = (value: unknown): boolean => {
    if (value === undefined || value === '' || value === ref) return true;
    if (typeof value !== 'string') return false;
    // An allocated id is what this flow writes now, and an id carries no stage
    // in its shape, so the per-stage scoping above has nothing to read. What
    // stands in for it is the binding: this element names THIS job through
    // `mediaRef`, which is the agent re-pointing it at a new generation, and
    // the previous generation's id is what it is replacing.
    if (isAllocatedAssetId(value)) return true;
    if (value.startsWith(generatedPrefix)) return true;
    try {
      return new URL(value).pathname.startsWith(generatedPrefix);
    } catch {
      return false;
    }
  };
  let patched = 0;
  for (const candidate of doc.scenes) {
    if (candidate.type !== 'slide') continue;
    const scene = await store.getScene(stageId, candidate.id);
    if (!scene || scene.type !== 'slide' || scene.content.type !== 'slide') continue;
    const canvas = scene.content.canvas;
    let touched = false;
    const elements = canvas.elements.map((element) => {
      if (
        element.type === 'video' &&
        (element.mediaRef === ref || element.src === ref) &&
        // A user edit that already replaced the placeholder with their own
        // concrete src wins.
        isReplaceableSrc(element.src)
      ) {
        touched = true;
        // Both ids land in the one write: `putScene` is what commits a
        // freshly allocated entry, so a poster named by a second write would
        // be a second chance to lose it. A poster the store refused is absent
        // here, and an element's own poster is left alone rather than cleared.
        return {
          ...element,
          src: media.src,
          ...(media.poster ? { poster: media.poster } : {}),
        };
      }
      return element;
    });
    if (!touched) continue;
    const next = {
      ...scene,
      content: { ...scene.content, canvas: { ...canvas, elements } },
    } as Scene;
    await runStageMutation(signal, () => store.putScene(stageId, next));
    patched += 1;
  }
  return patched;
}

interface VideoJobInput {
  toolCallId: string;
  ref: string;
  stageId: string;
  providerId: VideoProviderId;
  providerConfig: VideoGenerationConfig;
  model: string | undefined;
  options: VideoGenerationOptions;
  timeoutMs: number;
  deps: GenerateVideoToolDeps;
  callProvider: GenerateConfiguredVideo;
  persist: PersistGeneratedVideo;
}

/**
 * The detached submit → poll → download → persist → patch cycle.
 *
 * The job runs on its OWN timeout signal, deliberately NOT tied to the tool
 * call's abortSignal anymore: a cancelled chat must not silently orphan a
 * billable provider job (the classic orchestrator accepts the same caveat —
 * a provider-side submit that already happened is never recalled). The cost
 * is that a cancelled session's video still lands and patches the page.
 */
async function runVideoGenerationJob(input: VideoJobInput): Promise<void> {
  const { deps, ref, stageId, toolCallId } = input;
  const signal = AbortSignal.timeout(input.timeoutMs);
  const emit = (data: MediaReadyLifecycleData): Promise<void> =>
    emitMediaReadyFrame(deps, toolCallId, data);

  try {
    setPendingMediaStage(ref, 'submit');
    const result = await awaitWithSignal(
      input.callProvider(input.providerConfig, { ...input.options, signal }),
      signal,
    );
    throwIfAborted(signal);
    setPendingMediaStage(ref, 'persist');
    const stored = await input.persist({ result, stageId, signal });
    throwIfAborted(signal);

    void recordGenerationUsage({
      kind: 'video',
      unit: 'second',
      providerId: input.providerId,
      modelId: input.model,
      quantity: result.duration,
    });
    log.info(
      `[${toolCallId}] Video generated: provider=${input.providerId}, model=${input.model ?? 'default'}, ${result.width}x${result.height}, ${result.duration}s`,
    );

    if (deps.backgroundStore) {
      setPendingMediaStage(ref, 'patch');
      try {
        // The patch runs on its own short budget: the shared job signal may
        // be nearly exhausted by the provider cycle, and a patch failure must
        // not rebrand a persisted, downloadable asset as failed — the done
        // frame's src still lets connected clients render it.
        const patched = await patchStageVideoPlaceholder(
          deps.backgroundStore,
          stageId,
          ref,
          { src: stored.src, ...(stored.poster ? { poster: stored.poster } : {}) },
          AbortSignal.timeout(GENERATE_VIDEO_PATCH_TIMEOUT_MS),
        );
        if (patched > 0) {
          log.info(`[${toolCallId}] Patched ${ref} onto ${patched} page(s) of stage ${stageId}`);
        }
      } catch (error) {
        log.error(`[${toolCallId}] Document patch failed for ${ref}`, error);
      }
    }

    settlePendingMedia(ref, { status: 'done', src: stored.src, mime: stored.mime });
    await emit({
      ref,
      stageId,
      status: 'done',
      src: stored.src,
      mime: stored.mime,
      ...(result.duration ? { durationSec: result.duration } : {}),
    });
  } catch (error) {
    // A full store is its own outcome, not a provider failure: nothing was
    // written, the document was not patched, and the condition is one an
    // operator clears rather than one a retry outlasts. The code is the same
    // one the browser's media-failure table already understands, so the
    // workbench says why instead of showing a generic failure.
    const reason =
      error instanceof AssetStorageFullError
        ? MEDIA_TOOL_ERROR_REASONS.storageFull
        : isTimeout(signal)
          ? MEDIA_TOOL_ERROR_REASONS.timeout
          : MEDIA_TOOL_ERROR_REASONS.generationFailed;
    const message = error instanceof Error ? error.message : String(error);
    if (reason === MEDIA_TOOL_ERROR_REASONS.storageFull) {
      log.warn(
        `[${toolCallId}] Video generation refused: the asset store is full, ${ref} was not stored`,
      );
    } else if (reason === MEDIA_TOOL_ERROR_REASONS.timeout) {
      log.warn(
        `[${toolCallId}] Video generation timed out: provider=${input.providerId}, model=${input.model ?? 'default'}, timeoutMs=${input.timeoutMs}`,
      );
    } else {
      log.error(
        `[${toolCallId}] Video generation failed: provider=${input.providerId}, model=${input.model ?? 'default'}, error=${message}`,
        error,
      );
    }
    settlePendingMedia(ref, { status: 'failed', errorCode: reason });
    await emit({ ref, stageId, status: 'failed', errorCode: reason });
  }
}

export function buildGenerateVideoTool(
  deps: GenerateVideoToolDeps,
): AgentTool<typeof GenerateVideoParams, unknown> {
  const getConfigured = deps.getConfiguredVideoProviders ?? getServerVideoProviders;
  const resolveConfig = deps.resolveVideoProviderConfig ?? defaultResolveVideoProviderConfig;
  const callProvider = deps.generateConfiguredVideo ?? generateVideo;
  const persist = deps.persistGeneratedVideo ?? defaultPersistGeneratedVideo;

  return {
    name: GENERATE_VIDEO_TOOL_NAME,
    label: 'Generate video',
    description:
      'Start creating a new video from a prompt for the explicitly targeted course. Returns IMMEDIATELY with a placeholder ref (gen_vid_...): the video generates in the background (this can take minutes) and the page updates itself when it is ready. Right after this call, put the returned ref on a video element — patch_stage set mediaRef (or src) of an existing element, or add a new video element carrying it. Video elements also support autoplay and poster. Do not wait for the video and do not retry while a ref is pending. This tool never edits a page itself.',
    parameters: GenerateVideoParams,
    async execute(toolCallId, params: Static<typeof GenerateVideoParams>, signal) {
      const callerSignal = signal ?? deps.abortSignal;
      throwIfAborted(callerSignal);

      const prompt = params.prompt.trim();
      if (!prompt) return errorResult('Video generation failed: prompt must not be empty.');
      const stageId = params.stageId;

      const configured = getConfigured();
      const providerId = configuredProviderIds(configured).find((id) => {
        const provider = VIDEO_PROVIDERS[id];
        return !provider.requiresApiKey || !!resolveConfig(id).apiKey;
      });
      if (!providerId) {
        log.warn(`[${toolCallId}] Video generation unavailable: no enabled server video provider`);
        return errorResult(
          'Video generation is unavailable: no server video provider is available.',
          {
            stageId,
            sessionId: deps.sessionId,
            reason: MEDIA_TOOL_ERROR_REASONS.noProvider,
          },
        );
      }

      // Defense in depth: the operator force-off is authoritative at the call
      // boundary — even if a caller explicitly selects a disabled provider id,
      // the call fails before any provider I/O (#665).
      if (isServerProviderDisabled('video', providerId)) {
        log.warn(
          `[${toolCallId}] Video generation rejected: provider ${providerId} is force-disabled`,
        );
        return errorResult('Video generation is unavailable.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.providerDisabled,
        });
      }

      const providerConfig = resolveConfig(providerId);
      const model = providerConfig.model;
      // Same fail-loud discipline as generate_image: the server-side model
      // resolution is authoritative, and a provider that expects an explicit
      // model errors here instead of silently defaulting.
      if ((VIDEO_PROVIDERS[providerId]?.models?.length ?? 0) > 0 && !model) {
        log.warn(
          `[${toolCallId}] Video generation unavailable: no model configured for provider ${providerId}`,
        );
        return errorResult(
          'Video generation is unavailable: no model is configured for the selected video provider on this server.',
          {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.missingModel,
          },
        );
      }
      const normalized = normalizeVideoOptions(providerId, {
        prompt,
        ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
        ...(params.durationSec ? { duration: params.durationSec } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
        stageId,
      });

      // All validation passed: mint the placeholder (same `gen_vid_<id>`
      // scheme the outline flow uses), register the job, detach it, and
      // return. The provider cycle runs in the background; `media_ready`
      // reports the outcome and the background job patches the persisted page.
      const ref = `gen_vid_${nanoid(8)}`;
      registerPendingMedia({
        ref,
        type: 'video',
        stageId,
        ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
        provider: providerId,
      });
      void runVideoGenerationJob({
        toolCallId,
        ref,
        stageId,
        providerId,
        providerConfig,
        model,
        options: normalized,
        timeoutMs: deps.timeoutMs ?? GENERATE_VIDEO_TIMEOUT_MS,
        deps,
        callProvider,
        persist,
      }).catch((error) => {
        // runVideoGenerationJob handles every expected failure itself; this is
        // the last-resort guard against an unhandled rejection from a bug.
        // Keep the handler synchronous and only call never-rejecting helpers
        // (emitMediaReadyFrame catches internally): a throw here would become
        // the very unhandled rejection this guard exists to contain.
        log.error(`[${toolCallId}] Video generation job crashed for ${ref}`, error);
        settlePendingMedia(ref, {
          status: 'failed',
          errorCode: MEDIA_TOOL_ERROR_REASONS.generationFailed,
        });
        // A crashed job never lands in the document, so without this frame
        // the client would keep rendering the placeholder skeleton forever.
        void emitMediaReadyFrame(deps, toolCallId, {
          ref,
          stageId,
          status: 'failed',
          errorCode: MEDIA_TOOL_ERROR_REASONS.generationFailed,
        });
      });

      return {
        content: [
          {
            type: 'text',
            text: `Video generation started in the background (ref=${ref}). Patch this ref onto a video element's mediaRef (or src) with patch_stage NOW so the page shows a placeholder; the element updates automatically when the video is ready (a media_ready event reports the outcome). Do not block on it.`,
          },
        ],
        details: {
          ref,
          stageId,
          status: 'generating',
        },
      };
    },
  };
}
