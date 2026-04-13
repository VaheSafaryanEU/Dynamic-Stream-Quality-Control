// ─────────────────────────────────────────────────────────────────────────────
// UniversalStreamSelector.ts  –  Unified entry point for all deployment contexts
// ─────────────────────────────────────────────────────────────────────────────
//
// This class unifies the two adaptation paths:
//
//   Multi-stream path  (streams.length > 1)
//     Uses the existing StreamSelector algorithm to pick among available
//     sub-streams.  The caller's UserRequirement is translated into a
//     UserPriority (RESOLUTION_PRIORITY or FPS_PRIORITY) and the appropriate
//     bandwidth budget is applied before dispatch.
//
//   Single-stream path  (streams.length === 1)
//     Delegates to NetworkAwareAdaptor.  No stream switching is possible;
//     the result reports viability and prescribes optional frame dropping.
//
// Both paths honour the same UserRequirement vocabulary, so the same call site
// works regardless of whether substreams exist.
//
// Deployment contexts
// ───────────────────
//  Asset side        — camera / encoder sends one or more streams downstream.
//  Asset ↔ client    — relay or media server picks the best of several streams.
//  Client side       — viewer receives one incoming stream; adapt or warn.
// ─────────────────────────────────────────────────────────────────────────────

import {
  NetworkQoS,
  Stream,
  UserPriority,
  UserRequirement,
  UniversalSelectionResult,
  SingleStreamResult,
  StreamRecommendation,
  UniversalStreamSelectorConfig,
  NetworkHealthAnalysis,
  NetworkHealthStatus,
} from './types.js';
import { StreamSelector }       from './StreamSelector.js';
import { NetworkAwareAdaptor }  from './NetworkAwareAdaptor.js';
import { StreamAdvisor }        from './StreamAdvisor.js';
import { QoSAnalyzer }          from './QoSAnalyzer.js';

const DEFAULT_CONFIG: UniversalStreamSelectorConfig = {
  bandwidthSafetyMargin:    0.20,
  minViableFps:             5,
  lowLatencyBudgetFraction: 0.50,
};

/**
 * UniversalStreamSelector
 * ────────────────────────
 * One class, three deployment contexts, one API.
 *
 * For multi-stream scenarios call `select()`.
 * For single-stream scenarios call `evaluateSingle()`.
 *
 * The `UserRequirement` parameter replaces the old `UserPriority` parameter at
 * the call site.  Internally, requirements are translated to priorities so the
 * proven core algorithm is fully reused.
 *
 * Requirement → Priority mapping
 * ────────────────────────────────
 *  AUTO         → RESOLUTION_PRIORITY on EXCELLENT/GOOD networks;
 *                 FPS_PRIORITY on FAIR/POOR/CRITICAL networks
 *                 (smooth motion is more tolerable than stuttery high-res).
 *  BEST_QUALITY → RESOLUTION_PRIORITY (maximize pixels, never drop frames).
 *  BEST_FPS     → FPS_PRIORITY (maximize smoothness, drop frames if needed).
 *  LOW_LATENCY  → RESOLUTION_PRIORITY with a tighter bandwidth budget
 *                 (lowLatencyBudgetFraction limits bitrate headroom so the
 *                  link stays uncongested and buffering is minimised).
 *
 * Quick start
 * ───────────
 * ```ts
 * import { UniversalStreamSelector, UserRequirement } from 'dynamic-stream-quality-control';
 *
 * const selector = new UniversalStreamSelector();
 *
 * // ── Multi-stream (asset ↔ client, relay) ──────────────────────────────────
 * const result = selector.select(qos, streams, UserRequirement.BEST_QUALITY);
 * pipeline.switchStream(result.selectedStream.id);
 * if (result.frameDropStrategy?.active) {
 *   pipeline.setDropEveryNth(result.frameDropStrategy.dropEveryNthFrame);
 * }
 *
 * // ── Single-stream (client side, asset side) ───────────────────────────────
 * const single = selector.evaluateSingle(qos, myStream, UserRequirement.AUTO);
 * if (!single.viable) console.warn(single.reason);
 *
 * // ── No streams yet (encoder / client before opening) ─────────────────────
 * const rec = selector.recommend(qos, UserRequirement.BEST_QUALITY);
 * encoder.configure({ bitrateKbps: rec.maxBitrateKbps, fps: rec.recommendedFps,
 *                     width: rec.recommendedResolution?.widthPx ?? 1280,
 *                     height: rec.recommendedResolution?.heightPx ?? 720 });
 * ```
 */
export class UniversalStreamSelector {
  private readonly config:        UniversalStreamSelectorConfig;
  private readonly coreSelector:  StreamSelector;
  private readonly singleAdaptor: NetworkAwareAdaptor;
  private readonly advisor:       StreamAdvisor;
  private readonly qosAnalyzer:   QoSAnalyzer;

  constructor(config: Partial<UniversalStreamSelectorConfig> = {}) {
    this.config        = { ...DEFAULT_CONFIG, ...config };
    this.coreSelector  = new StreamSelector(this.config);
    this.singleAdaptor = new NetworkAwareAdaptor(this.config);
    this.advisor       = new StreamAdvisor(this.config);
    this.qosAnalyzer   = new QoSAnalyzer();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Select the best stream from a list of available streams based on network
   * conditions and user requirements.
   *
   * Works for both multi-stream and single-stream lists:
   *  - 1 stream  → delegates to evaluateSingle() and wraps the result.
   *  - 2+ streams → uses the full multi-stream selection algorithm.
   *
   * @param qos         Real-time QoS snapshot.
   * @param streams     All available streams. Must not be empty.
   * @param requirement What the user values most. Defaults to AUTO.
   * @returns           UniversalSelectionResult with selected stream, optional
   *                    frame-drop strategy, and network analysis.
   *
   * @throws Error if streams array is empty.
   */
  select(
    qos:         NetworkQoS,
    streams:     Stream[],
    requirement: UserRequirement = UserRequirement.AUTO,
  ): UniversalSelectionResult {
    if (streams.length === 0) {
      throw new Error('UniversalStreamSelector.select: streams array must not be empty.');
    }

    // Single stream: wrap evaluateSingle into UniversalSelectionResult
    if (streams.length === 1) {
      return this.wrapSingleResult(
        this.singleAdaptor.evaluate(qos, streams[0]!, requirement),
        requirement,
      );
    }

    // Multi-stream: analyse QoS, derive priority and budget, call core selector
    const networkHealth = this.qosAnalyzer.analyze(qos);
    const resolvedPriority = this.resolvePriority(requirement, networkHealth);
    const adjustedQoS      = this.adjustQoSForRequirement(qos, requirement, networkHealth);

    const coreResult = this.coreSelector.select(adjustedQoS, streams, resolvedPriority);

    const networkWarning =
      networkHealth.status === NetworkHealthStatus.POOR ||
      networkHealth.status === NetworkHealthStatus.CRITICAL;

    return {
      ...coreResult,
      requirement,
      resolvedPriority,
      networkWarning,
    };
  }

  /**
   * Evaluate a single stream against live network conditions.
   * Use this when there are no sub-streams to switch between.
   *
   * @param qos         Real-time QoS snapshot.
   * @param stream      The one available stream.
   * @param requirement What the user values most. Defaults to AUTO.
   * @returns           SingleStreamResult with viability and optional frame-drop.
   */
  evaluateSingle(
    qos:         NetworkQoS,
    stream:      Stream,
    requirement: UserRequirement = UserRequirement.AUTO,
  ): SingleStreamResult {
    return this.singleAdaptor.evaluate(qos, stream, requirement);
  }

  /**
   * Recommend stream properties when no stream list exists yet.
   *
   * Use this when you have not opened any stream and want to know what bitrate,
   * fps, and resolution to request or configure.  Typical callers:
   *
   *  • An encoder deciding its output preset before starting.
   *  • A client asking the server for the best matching profile.
   *  • A relay provisioning an output tier on demand.
   *
   * @param qos         Real-time QoS snapshot.
   * @param requirement What the user values most. Defaults to AUTO.
   * @returns           StreamRecommendation with maxBitrateKbps, recommendedFps,
   *                    recommendedResolution, and a human-readable reason.
   */
  recommend(
    qos:         NetworkQoS,
    requirement: UserRequirement = UserRequirement.AUTO,
  ): StreamRecommendation {
    return this.advisor.recommend(qos, requirement);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Map a UserRequirement to a UserPriority for the core StreamSelector.
   *
   * AUTO on a degraded network favours FPS_PRIORITY because stuttery video
   * caused by resolution-induced rebuffering is more disruptive than
   * watching the same content at a lower resolution with consistent motion.
   */
  private resolvePriority(
    requirement:   UserRequirement,
    networkHealth: NetworkHealthAnalysis,
  ): UserPriority {
    switch (requirement) {
      case UserRequirement.BEST_QUALITY:
        return UserPriority.RESOLUTION_PRIORITY;

      case UserRequirement.BEST_FPS:
        return UserPriority.FPS_PRIORITY;

      case UserRequirement.LOW_LATENCY:
        // Low-latency prefers resolution (clean frames) but with a tighter
        // budget applied via adjustQoSForRequirement.
        return UserPriority.RESOLUTION_PRIORITY;

      case UserRequirement.AUTO:
      default: {
        const degraded =
          networkHealth.status === NetworkHealthStatus.FAIR  ||
          networkHealth.status === NetworkHealthStatus.POOR  ||
          networkHealth.status === NetworkHealthStatus.CRITICAL;
        return degraded ? UserPriority.FPS_PRIORITY : UserPriority.RESOLUTION_PRIORITY;
      }
    }
  }

  /**
   * Optionally reduce the reported bandwidth before passing to the core
   * selector.  Used for LOW_LATENCY mode so the selector picks a stream that
   * leaves headroom on the link, reducing queuing delay.
   *
   * All other requirements pass QoS through unchanged — the core selector's
   * own bandwidthSafetyMargin already reserves 20 % headroom.
   */
  private adjustQoSForRequirement(
    qos:           NetworkQoS,
    requirement:   UserRequirement,
    networkHealth: NetworkHealthAnalysis,
  ): NetworkQoS {
    if (requirement !== UserRequirement.LOW_LATENCY) return qos;

    // Cap reported bandwidth at (effectiveBandwidth × lowLatencyBudgetFraction).
    // The core selector will then apply its own safety margin on top of this.
    const cappedBandwidth = Math.floor(
      networkHealth.effectiveBandwidthKbps * this.config.lowLatencyBudgetFraction,
    );

    return { ...qos, bandwidthKbps: Math.min(qos.bandwidthKbps, cappedBandwidth) };
  }

  /**
   * Promote a SingleStreamResult into an UniversalSelectionResult so callers
   * always receive the same shape regardless of stream count.
   */
  private wrapSingleResult(
    single:      SingleStreamResult,
    requirement: UserRequirement,
  ): UniversalSelectionResult {
    const resolvedPriority = UserPriority.RESOLUTION_PRIORITY; // no multi-stream choice

    return {
      selectedStream:    single.stream,
      frameDropStrategy: single.frameDropStrategy,
      networkHealth:     single.networkHealth,
      reason:            single.reason,
      qualityScore:      single.qualityScore,
      timestamp:         single.timestamp,
      requirement,
      resolvedPriority,
      networkWarning:
        !single.viable ||
        single.networkHealth.status === NetworkHealthStatus.POOR ||
        single.networkHealth.status === NetworkHealthStatus.CRITICAL,
    };
  }
}
