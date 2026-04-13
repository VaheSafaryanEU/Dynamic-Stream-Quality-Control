// ─────────────────────────────────────────────────────────────────────────────
// StreamAdvisor.ts  –  Stream property recommendation when no streams exist yet
// ─────────────────────────────────────────────────────────────────────────────
//
// Use this when the caller has NO stream list at all — e.g.:
//
//   • An encoder that has not started yet and wants to know what bitrate /
//     resolution / fps preset to configure before opening the stream.
//   • A client that is about to request a stream from a server and wants to
//     ask for the best profile for its current network.
//   • A relay or MCU deciding which output tier to provision dynamically.
//
// The advisor inspects the QoS snapshot and the user's requirement, then
// returns concrete recommended stream properties (bitrate, fps, resolution
// tier).  These are maximums — the caller is free to pick lower values.
// ─────────────────────────────────────────────────────────────────────────────

import {
  NetworkQoS,
  UserRequirement,
  StreamRecommendation,
  ResolutionTier,
  NetworkHealthAnalysis,
  NetworkHealthStatus,
  StreamSelectorConfig,
} from './types.js';
import { QoSAnalyzer } from './QoSAnalyzer.js';

// ─── Built-in resolution tier table ──────────────────────────────────────────
// Ordered from highest to lowest quality.
// Bitrate figures: H.264 High, ~25 fps, medium-motion content.
const RESOLUTION_TIERS: ResolutionTier[] = [
  { label: '4K',   widthPx: 3840, heightPx: 2160, minBitrateKbps: 15_000, recommendedBitrateKbps: 25_000 },
  { label: '1440p', widthPx: 2560, heightPx: 1440, minBitrateKbps:  8_000, recommendedBitrateKbps: 12_000 },
  { label: '1080p', widthPx: 1920, heightPx: 1080, minBitrateKbps:  3_000, recommendedBitrateKbps:  5_000 },
  { label: '720p',  widthPx: 1280, heightPx:  720, minBitrateKbps:  1_500, recommendedBitrateKbps:  2_500 },
  { label: '480p',  widthPx:  854, heightPx:  480, minBitrateKbps:    600, recommendedBitrateKbps:  1_000 },
  { label: '360p',  widthPx:  640, heightPx:  360, minBitrateKbps:    300, recommendedBitrateKbps:    500 },
  { label: '240p',  widthPx:  426, heightPx:  240, minBitrateKbps:    150, recommendedBitrateKbps:    250 },
  { label: '160p',  widthPx:  284, heightPx:  160, minBitrateKbps:     64, recommendedBitrateKbps:    128 },
];

const DEFAULT_CONFIG: StreamSelectorConfig = {
  bandwidthSafetyMargin: 0.20,
  minViableFps:          5,
};

/**
 * StreamAdvisor
 * ──────────────
 * Produces stream property recommendations from raw QoS data alone — no
 * existing stream list is required.
 *
 * The output tells the caller:
 *  • `maxBitrateKbps`         — upper bitrate limit safe for this network.
 *  • `recommendedFps`         — target frame rate given the requirement.
 *  • `recommendedResolution`  — the best named resolution tier that fits.
 *
 * Typical usage patterns
 * ───────────────────────
 * ```ts
 * // Encoder — configure before starting the stream:
 * const advisor = new StreamAdvisor();
 * const rec = advisor.recommend(qos, UserRequirement.BEST_QUALITY);
 * encoder.configure({
 *   bitrateKbps: rec.maxBitrateKbps,
 *   fps:         rec.recommendedFps,
 *   width:       rec.recommendedResolution?.widthPx ?? 1280,
 *   height:      rec.recommendedResolution?.heightPx ?? 720,
 * });
 *
 * // Client — request best profile before opening connection:
 * const rec = advisor.recommend(qos, UserRequirement.AUTO);
 * requestStream({ profile: rec.recommendedResolution?.label ?? '360p' });
 * ```
 *
 * The advisor is stateless and synchronous; call it as often as needed from
 * your adaptation loop.
 */
export class StreamAdvisor {
  private readonly config:      StreamSelectorConfig;
  private readonly qosAnalyzer: QoSAnalyzer;

  constructor(config: Partial<StreamSelectorConfig> = {}) {
    this.config      = { ...DEFAULT_CONFIG, ...config };
    this.qosAnalyzer = new QoSAnalyzer();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Recommend stream properties for the given QoS and user requirement.
   *
   * @param qos         Real-time QoS snapshot.
   * @param requirement What the viewer / encoder wants. Defaults to AUTO.
   * @returns           StreamRecommendation with bitrate, fps, resolution tier,
   *                    and a human-readable reason.
   */
  recommend(
    qos:         NetworkQoS,
    requirement: UserRequirement = UserRequirement.AUTO,
  ): StreamRecommendation {
    const networkHealth       = this.qosAnalyzer.analyze(qos);
    const usableBandwidthKbps =
      networkHealth.effectiveBandwidthKbps * (1 - this.config.bandwidthSafetyMargin);

    const maxBitrateKbps   = Math.floor(usableBandwidthKbps);
    const recommendedFps   = this.deriveFps(requirement, networkHealth);
    const recommendedResolution = this.pickResolutionTier(maxBitrateKbps, requirement);

    return {
      maxBitrateKbps,
      recommendedFps,
      recommendedResolution,
      requirement,
      networkHealth,
      reason: this.buildReason(
        requirement, networkHealth, maxBitrateKbps, recommendedFps, recommendedResolution,
      ),
      timestamp: Date.now(),
    };
  }

  /**
   * Expose the built-in resolution tier table so callers can inspect or
   * override it.  Returns a defensive copy; mutating the result has no effect.
   */
  getResolutionTiers(): ResolutionTier[] {
    return [...RESOLUTION_TIERS];
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Derive the recommended fps from the requirement and network health.
   *
   * BEST_QUALITY → up to 30 fps (maximise temporal detail within budget).
   * BEST_FPS     → 30 fps target regardless of network (caller will drop frames
   *                if needed, but the encoder should produce full fps).
   * LOW_LATENCY  → 15 fps — halving the frame rate reduces encoder buffer depth,
   *                cutting glass-to-glass delay by roughly one GOP period.
   * AUTO         → scales down with network degradation:
   *                EXCELLENT → 30, GOOD → 25, FAIR → 20, POOR → 15, CRITICAL → 5.
   */
  private deriveFps(
    requirement:   UserRequirement,
    networkHealth: NetworkHealthAnalysis,
  ): number {
    switch (requirement) {
      case UserRequirement.BEST_QUALITY: return 30;
      case UserRequirement.BEST_FPS:     return 30;
      case UserRequirement.LOW_LATENCY:  return 15;
      case UserRequirement.AUTO:
      default:
        return this.autoFps(networkHealth.status);
    }
  }

  private autoFps(status: NetworkHealthStatus): number {
    switch (status) {
      case NetworkHealthStatus.EXCELLENT: return 30;
      case NetworkHealthStatus.GOOD:      return 25;
      case NetworkHealthStatus.FAIR:      return 20;
      case NetworkHealthStatus.POOR:      return 15;
      case NetworkHealthStatus.CRITICAL:  return 5;
    }
  }

  /**
   * Pick the best resolution tier whose recommended bitrate fits within the
   * usable budget.
   *
   * For BEST_FPS the budget is divided by the fps ratio vs 25 fps baseline,
   * because a 30 fps stream at 720p costs more than a 25 fps stream.
   * For all other requirements the full budget is used directly.
   *
   * Falls back to the lowest tier if none fits at recommended bitrate but
   * the minimum bitrate fits.  Returns null only when even the floor tier
   * cannot fit (network is critically constrained).
   */
  private pickResolutionTier(
    maxBitrateKbps: number,
    requirement:    UserRequirement,
  ): ResolutionTier | null {
    // For BEST_FPS at 30 fps, reduce the effective budget slightly because
    // 30 fps streams run ~20 % higher bitrate than 25 fps at the same resolution.
    const effectiveBudget =
      requirement === UserRequirement.BEST_FPS
        ? Math.floor(maxBitrateKbps / 1.2)
        : maxBitrateKbps;

    // First pass: find highest tier where recommended bitrate fits.
    for (const tier of RESOLUTION_TIERS) {
      if (tier.recommendedBitrateKbps <= effectiveBudget) return tier;
    }

    // Second pass: fall back to highest tier where minimum bitrate fits.
    for (const tier of RESOLUTION_TIERS) {
      if (tier.minBitrateKbps <= effectiveBudget) return tier;
    }

    return null; // budget too low for any tier
  }

  private buildReason(
    requirement:          UserRequirement,
    networkHealth:        NetworkHealthAnalysis,
    maxBitrateKbps:       number,
    recommendedFps:       number,
    resolution:           ResolutionTier | null,
  ): string {
    const health = networkHealth.status;
    const issues = networkHealth.issues.length > 0
      ? ` Issues: ${networkHealth.issues.join('; ')}.`
      : '';

    const resLabel = resolution
      ? `${resolution.label} (${resolution.widthPx}×${resolution.heightPx})`
      : 'none — network too poor for any resolution tier';

    return (
      `[${requirement}] Network health: ${health}.${issues} ` +
      `Usable bandwidth: ${maxBitrateKbps} Kbps. ` +
      `Recommended: ${resLabel}, ${recommendedFps} fps, ≤${maxBitrateKbps} Kbps.`
    );
  }
}
