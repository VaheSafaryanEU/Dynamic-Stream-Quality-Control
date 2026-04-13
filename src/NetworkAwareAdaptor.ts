// ─────────────────────────────────────────────────────────────────────────────
// NetworkAwareAdaptor.ts  –  Single-stream adaptation when no substreams exist
// ─────────────────────────────────────────────────────────────────────────────
//
// This module handles the case where the caller has exactly one stream (or
// wants to evaluate a single stream in isolation).  Because there is nothing
// to switch to, it can only:
//
//   • Report whether the stream fits the current network budget.
//   • Prescribe a frame-drop strategy to reduce effective bitrate when the
//     stream does NOT fit (allowed for BEST_FPS / AUTO on a degraded network).
//   • Expose a NetworkHealthAnalysis so the caller can surface warnings.
//
// This is the "client-side" or "single-asset" adaptation path.  When multiple
// streams are available, use UniversalStreamSelector instead.
// ─────────────────────────────────────────────────────────────────────────────

import {
  NetworkQoS,
  Stream,
  UserRequirement,
  SingleStreamResult,
  NetworkHealthAnalysis,
  NetworkHealthStatus,
  FrameDropStrategy,
  StreamSelectorConfig,
} from './types.js';
import { QoSAnalyzer }         from './QoSAnalyzer.js';
import { FrameDropCalculator } from './FrameDropCalculator.js';

const DEFAULT_CONFIG: StreamSelectorConfig = {
  bandwidthSafetyMargin: 0.20,
  minViableFps:          5,
};

/**
 * NetworkAwareAdaptor
 * ────────────────────
 * Evaluates a single stream against live network conditions and returns an
 * actionable `SingleStreamResult`.
 *
 * Intended deployment contexts
 * ─────────────────────────────
 *  • Client side  — the viewer has one incoming stream; adapt or warn.
 *  • Asset side   — an encoder has one outgoing stream; decide whether to
 *                   reduce quality at the source.
 *  • Edge relay   — a relay node with a single upstream; decide whether to
 *                   drop frames before forwarding downstream.
 *
 * Frame-drop policy per requirement
 * ───────────────────────────────────
 *  AUTO         → drop frames when network is POOR or CRITICAL.
 *  BEST_QUALITY → never drop frames; report viable=false when over budget.
 *  BEST_FPS     → always drop frames to fit the budget (keeps motion smooth).
 *  LOW_LATENCY  → never drop frames; simply report whether the stream fits.
 *
 * Quick start
 * ───────────
 * ```ts
 * const adaptor = new NetworkAwareAdaptor();
 * const result  = adaptor.evaluate(qos, myStream, UserRequirement.BEST_FPS);
 *
 * if (result.frameDropStrategy?.active) {
 *   pipeline.setDropEveryNth(result.frameDropStrategy.dropEveryNthFrame);
 * } else if (!result.viable) {
 *   ui.showNetworkWarning(result.reason);
 * }
 * ```
 */
export class NetworkAwareAdaptor {
  private readonly config:        StreamSelectorConfig;
  private readonly qosAnalyzer:   QoSAnalyzer;
  private readonly frameDropCalc: FrameDropCalculator;

  constructor(config: Partial<StreamSelectorConfig> = {}) {
    this.config        = { ...DEFAULT_CONFIG, ...config };
    this.qosAnalyzer   = new QoSAnalyzer();
    this.frameDropCalc = new FrameDropCalculator();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Evaluate a single stream against live network conditions.
   *
   * @param qos         Real-time QoS snapshot.
   * @param stream      The one available stream to evaluate.
   * @param requirement How the user wants the stream delivered.
   *                    Defaults to AUTO when omitted.
   * @returns           SingleStreamResult with viability, optional frame-drop
   *                    strategy, and full QoS analysis.
   */
  evaluate(
    qos:         NetworkQoS,
    stream:      Stream,
    requirement: UserRequirement = UserRequirement.AUTO,
  ): SingleStreamResult {
    const networkHealth      = this.qosAnalyzer.analyze(qos);
    const usableBandwidthKbps =
      networkHealth.effectiveBandwidthKbps * (1 - this.config.bandwidthSafetyMargin);

    const viable = stream.bitrateKbps <= usableBandwidthKbps;

    if (viable) {
      return this.buildResult(
        stream,
        null,
        networkHealth,
        viable,
        this.viableReason(stream, networkHealth, usableBandwidthKbps),
      );
    }

    // Stream does NOT fit — decide whether to drop frames or just warn.
    const frameDrop = this.shouldDropFrames(requirement, networkHealth)
      ? this.frameDropCalc.calculate(stream, usableBandwidthKbps)
      : null;

    return this.buildResult(
      stream,
      frameDrop,
      networkHealth,
      false,
      this.notViableReason(stream, requirement, networkHealth, usableBandwidthKbps, frameDrop),
    );
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Determine whether frame dropping should be prescribed.
   *
   * AUTO     → drop only when the network is degraded (POOR / CRITICAL).
   * BEST_FPS → always drop to fit the budget and keep motion smooth.
   * Others   → never drop (BEST_QUALITY wants clean frames; LOW_LATENCY
   *             wants the stream as-is so the encoder can decide).
   */
  private shouldDropFrames(
    requirement:   UserRequirement,
    networkHealth: NetworkHealthAnalysis,
  ): boolean {
    if (requirement === UserRequirement.BEST_FPS) return true;
    if (requirement === UserRequirement.AUTO) {
      return (
        networkHealth.status === NetworkHealthStatus.POOR ||
        networkHealth.status === NetworkHealthStatus.CRITICAL
      );
    }
    return false;
  }

  private viableReason(
    stream:              Stream,
    networkHealth:       NetworkHealthAnalysis,
    usableBandwidthKbps: number,
  ): string {
    return (
      `Stream "${stream.label}" (${stream.bitrateKbps} Kbps) fits within the ` +
      `${usableBandwidthKbps.toFixed(0)} Kbps usable budget. ` +
      `Network health: ${networkHealth.status}.`
    );
  }

  private notViableReason(
    stream:              Stream,
    requirement:         UserRequirement,
    networkHealth:       NetworkHealthAnalysis,
    usableBandwidthKbps: number,
    frameDrop:           FrameDropStrategy | null,
  ): string {
    const base =
      `Stream "${stream.label}" requires ${stream.bitrateKbps} Kbps but only ` +
      `${usableBandwidthKbps.toFixed(0)} Kbps is usable ` +
      `(network: ${networkHealth.status}).`;

    if (frameDrop?.active) {
      return (
        `${base} Applying frame dropping (keep 1 of every ` +
        `${frameDrop.dropEveryNthFrame} frames, ~${frameDrop.effectiveFps.toFixed(1)} fps, ` +
        `~${frameDrop.effectiveBitrateKbps} Kbps) per ${requirement} requirement.`
      );
    }

    const advice =
      requirement === UserRequirement.BEST_QUALITY
        ? 'BEST_QUALITY: no frame dropping applied — reduce encoder bitrate if possible.'
        : requirement === UserRequirement.LOW_LATENCY
        ? 'LOW_LATENCY: stream exceeds budget; reduce encoder bitrate to improve latency.'
        : 'Consider reducing encoder bitrate or switching to a lower preset.';

    return `${base} ${advice}`;
  }

  private buildResult(
    stream:        Stream,
    frameDrop:     FrameDropStrategy | null,
    networkHealth: NetworkHealthAnalysis,
    viable:        boolean,
    reason:        string,
  ): SingleStreamResult {
    return {
      stream,
      viable,
      frameDropStrategy: frameDrop,
      networkHealth,
      reason,
      qualityScore: this.computeQualityScore(stream, frameDrop, networkHealth),
      timestamp:    Date.now(),
    };
  }

  /**
   * Perceived quality score [0, 100].
   * Weights: 40 % resolution, 30 % fps, 20 % network health, 10 % drop penalty.
   */
  private computeQualityScore(
    stream:        Stream,
    frameDrop:     FrameDropStrategy | null,
    networkHealth: NetworkHealthAnalysis,
  ): number {
    const BASELINE_PIXELS = 1920 * 1080;
    const BASELINE_FPS    = 60;

    const resScore     = Math.min(1.0, (stream.widthPx * stream.heightPx) / BASELINE_PIXELS);
    const effectiveFps = frameDrop?.active ? frameDrop.effectiveFps : stream.fps;
    const fpsScore     = Math.min(1.0, effectiveFps / BASELINE_FPS);
    const healthScore  = this.healthToScore(networkHealth.status);
    const dropPenalty  = frameDrop?.active ? frameDrop.keepRatio : 1.0;

    return Math.round(
      (resScore * 0.40 + fpsScore * 0.30 + healthScore * 0.20 + dropPenalty * 0.10) * 100,
    );
  }

  private healthToScore(status: NetworkHealthStatus): number {
    const map: Record<NetworkHealthStatus, number> = {
      [NetworkHealthStatus.EXCELLENT]: 1.00,
      [NetworkHealthStatus.GOOD]:      0.85,
      [NetworkHealthStatus.FAIR]:      0.65,
      [NetworkHealthStatus.POOR]:      0.40,
      [NetworkHealthStatus.CRITICAL]:  0.10,
    };
    return map[status] ?? 0;
  }
}
