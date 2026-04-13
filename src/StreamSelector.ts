// ─────────────────────────────────────────────────────────────────────────────
// StreamSelector.ts  –  Main orchestrator: pure, server-agnostic logic module
// ─────────────────────────────────────────────────────────────────────────────

import {
  NetworkQoS,
  Stream,
  UserPriority,
  SelectionResult,
  StreamSelectorConfig,
  FrameDropStrategy,
  NetworkHealthAnalysis,
  NetworkHealthStatus,
} from './types.js';
import { QoSAnalyzer }         from './QoSAnalyzer.js';
import { FrameDropCalculator } from './FrameDropCalculator.js';

const DEFAULT_CONFIG: StreamSelectorConfig = {
  bandwidthSafetyMargin: 0.20, // reserve 20 % headroom above selected bitrate
  minViableFps:          5,    // below this fps frame-dropping is not useful
};

/**
 * StreamSelector
 * ──────────────
 * Pure logic module – zero I/O, zero network code, zero streaming-library imports.
 * Takes a QoS snapshot + available stream list, returns an actionable decision.
 *
 * Thread / concurrency safety
 * ────────────────────────────
 * All public methods are synchronous and side-effect-free. A single instance
 * can be called concurrently from multiple coroutines / worker threads.
 *
 * Quick start
 * ───────────
 * ```ts
 * import { StreamSelector, UserPriority } from 'dynamic-stream-quality-control';
 *
 * const selector = new StreamSelector();
 *
 * // Call every 1–3 s from your adaptation loop:
 * const result = selector.select(currentQoS, availableStreams, UserPriority.RESOLUTION_PRIORITY);
 *
 * if (result.frameDropStrategy?.active) {
 *   pipeline.setDropEveryNth(result.frameDropStrategy.dropEveryNthFrame);
 * } else {
 *   pipeline.clearFrameDrop();
 * }
 * pipeline.switchStream(result.selectedStream.id);
 * ```
 *
 * Priority modes
 * ──────────────
 * RESOLUTION_PRIORITY
 *   Always selects the highest-resolution stream that fits the available
 *   bandwidth. Never applies frame dropping. A smooth lower-res stream is
 *   always preferred over a choppy high-res one.
 *
 * FPS_PRIORITY
 *   Selects the stream with the highest frame rate within budget.
 *   Falls back to the lowest-bitrate stream with frame dropping as a
 *   last resort when nothing fits.
 *
 * Handling fps=0 / unprobed streams
 * ───────────────────────────────────
 * Pass fps=0 and widthPx=0/heightPx=0 when a stream hasn't been probed yet.
 * The selector uses bitrateKbps as a quality proxy in that case, so decisions
 * remain reasonable before probe data is available.
 */
export class StreamSelector {
  private readonly config: StreamSelectorConfig;
  private readonly qosAnalyzer: QoSAnalyzer;
  private readonly frameDropCalc: FrameDropCalculator;

  constructor(config: Partial<StreamSelectorConfig> = {}) {
    this.config        = { ...DEFAULT_CONFIG, ...config };
    this.qosAnalyzer   = new QoSAnalyzer();
    this.frameDropCalc = new FrameDropCalculator();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Compute the optimal stream selection and optional frame-drop strategy.
   *
   * @param qos      Real-time QoS snapshot (bandwidth, latency, jitter, loss).
   * @param streams  All available pre-encoded streams. Order is irrelevant.
   * @param priority RESOLUTION_PRIORITY or FPS_PRIORITY.
   * @returns        SelectionResult – switch to selectedStream; apply
   *                 frameDropStrategy if non-null and active.
   *
   * @throws Error   If streams array is empty.
   */
  select(
    qos:      NetworkQoS,
    streams:  Stream[],
    priority: UserPriority,
  ): SelectionResult {
    if (streams.length === 0) {
      throw new Error('StreamSelector.select: streams array must not be empty.');
    }

    // ── 1. Analyse network health & derive effective bandwidth ────────────────
    const networkHealth = this.qosAnalyzer.analyze(qos);

    const usableBandwidthKbps =
      networkHealth.effectiveBandwidthKbps * (1 - this.config.bandwidthSafetyMargin);

    // ── 2. Sort streams: highest quality first ────────────────────────────────
    // Primary key: pixel count (resolution).
    // Secondary: fps — falls back to bitrate/1000 when fps=0 (probe pending).
    // Keeping these separate avoids the degenerate case where fps=0 collapses
    // all scores to 0 regardless of resolution.
    const sortedStreams = [...streams].sort((a, b) => {
      const pixA = a.widthPx * a.heightPx;
      const pixB = b.widthPx * b.heightPx;
      if (pixB !== pixA) return pixB - pixA;
      const fpsA = a.fps > 0 ? a.fps : a.bitrateKbps / 1000;
      const fpsB = b.fps > 0 ? b.fps : b.bitrateKbps / 1000;
      return fpsB - fpsA;
    });

    // ── 3. Identify the main stream ───────────────────────────────────────────
    // Honour explicit isMainStream flag; fall back to the highest-quality stream.
    const mainStream: Stream =
      sortedStreams.find((s) => s.isMainStream) ?? sortedStreams[0]!;

    // ── 4. Filter streams that fit within usable bandwidth ────────────────────
    const fittingStreams = sortedStreams.filter(
      (s) => s.bitrateKbps <= usableBandwidthKbps,
    );

    // ── 5. Dispatch to priority-specific selection logic ──────────────────────
    if (priority === UserPriority.FPS_PRIORITY) {
      return this.selectFpsPriority(
        fittingStreams, sortedStreams, networkHealth, usableBandwidthKbps,
      );
    }

    return this.selectResolutionPriority(
      mainStream, fittingStreams, sortedStreams, networkHealth, usableBandwidthKbps,
    );
  }

  // ─── Priority-specific selection logic ────────────────────────────────────

  /**
   * FPS_PRIORITY: find the stream with the highest frame rate that fits
   * within the usable bandwidth. If nothing fits, apply frame dropping to
   * the lowest-bitrate stream so at least something plays.
   */
  private selectFpsPriority(
    fittingStreams:     Stream[],
    allSortedStreams:   Stream[],
    networkHealth:     NetworkHealthAnalysis,
    usableBandwidthKbps: number,
  ): SelectionResult {
    if (fittingStreams.length === 0) {
      const lowestBitrateStream = allSortedStreams[allSortedStreams.length - 1]!;
      const frameDrop = this.frameDropCalc.calculate(lowestBitrateStream, usableBandwidthKbps);

      return this.buildResult(
        lowestBitrateStream,
        frameDrop,
        networkHealth,
        `FPS_PRIORITY (fallback): no stream fits ${usableBandwidthKbps.toFixed(0)} Kbps budget. ` +
          `Using ${lowestBitrateStream.label} with frame dropping as last resort.`,
      );
    }

    // Among fitting streams, pick the one with the highest fps.
    // When fps=0 (probe not yet available), use bitrate as a proxy.
    // Tie-break by resolution (higher wins).
    const effectiveFpsOf = (s: Stream) => s.fps > 0 ? s.fps : s.bitrateKbps / 1000;

    const bestFpsStream = fittingStreams.reduce((best, cur) => {
      const fpsA = effectiveFpsOf(best);
      const fpsB = effectiveFpsOf(cur);
      if (fpsB > fpsA) return cur;
      if (fpsB === fpsA && cur.widthPx * cur.heightPx > best.widthPx * best.heightPx) return cur;
      return best;
    });

    const displayFps = bestFpsStream.fps > 0 ? `${bestFpsStream.fps} fps` : 'fps not yet probed';
    return this.buildResult(
      bestFpsStream,
      null,
      networkHealth,
      `FPS_PRIORITY: selected ${bestFpsStream.label} (${displayFps}) ` +
        `as the best stream within the ${usableBandwidthKbps.toFixed(0)} Kbps usable budget.`,
    );
  }

  /**
   * RESOLUTION_PRIORITY:
   *  Select the highest-resolution stream that fits within the usable bandwidth.
   *  Frame dropping is never used — a clean lower-resolution stream is always
   *  preferable to a choppy high-resolution one.
   *
   *  1. If the main (highest-res) stream fits → use it.
   *  2. Otherwise pick the highest-resolution stream among those that fit.
   *  3. If nothing fits → use the lowest-bitrate stream as a last resort
   *     (no frame dropping).
   */
  private selectResolutionPriority(
    mainStream:          Stream,
    fittingStreams:      Stream[],
    allSortedStreams:    Stream[],
    networkHealth:       NetworkHealthAnalysis,
    usableBandwidthKbps: number,
  ): SelectionResult {
    // Happy path – main stream fits, no compromise needed
    if (mainStream.bitrateKbps <= usableBandwidthKbps) {
      return this.buildResult(
        mainStream,
        null,
        networkHealth,
        `RESOLUTION_PRIORITY: ${mainStream.label} fits within the ` +
          `${usableBandwidthKbps.toFixed(0)} Kbps usable budget – full quality.`,
      );
    }

    // Pick the highest-resolution stream that fits without any frame dropping
    const candidates = fittingStreams.filter((s) => s.id !== mainStream.id);

    if (candidates.length > 0) {
      const bestResolution = candidates.reduce((best, cur) => {
        const pixA = best.widthPx * best.heightPx;
        const pixB = cur.widthPx  * cur.heightPx;
        if (pixB !== pixA) return pixB > pixA ? cur : best;
        const fpsA = best.fps > 0 ? best.fps : best.bitrateKbps / 1000;
        const fpsB = cur.fps  > 0 ? cur.fps  : cur.bitrateKbps  / 1000;
        return fpsB > fpsA ? cur : best;
      });

      return this.buildResult(
        bestResolution,
        null,
        networkHealth,
        `RESOLUTION_PRIORITY: ${mainStream.label} needs ${mainStream.bitrateKbps} Kbps ` +
          `but only ${usableBandwidthKbps.toFixed(0)} Kbps available. ` +
          `Downgrading to ${bestResolution.label} (${bestResolution.widthPx}×${bestResolution.heightPx}) – best quality that fits without frame dropping.`,
      );
    }

    // Absolute floor – nothing fits; use lowest-bitrate stream, no frame dropping
    const lowestBitrate = allSortedStreams[allSortedStreams.length - 1]!;
    return this.buildResult(
      lowestBitrate,
      null,
      networkHealth,
      `RESOLUTION_PRIORITY (floor): no stream fits ${usableBandwidthKbps.toFixed(0)} Kbps budget. ` +
        `Using ${lowestBitrate.label} as last resort – no frame dropping applied.`,
    );
  }

  // ─── Score & result builder ────────────────────────────────────────────────

  private buildResult(
    stream:        Stream,
    frameDrop:     FrameDropStrategy | null,
    networkHealth: NetworkHealthAnalysis,
    reason:        string,
  ): SelectionResult {
    return {
      selectedStream:    stream,
      frameDropStrategy: frameDrop,
      networkHealth,
      reason,
      qualityScore: this.computeQualityScore(stream, frameDrop, networkHealth),
      timestamp:    Date.now(),
    };
  }

  /**
   * Produces a 0–100 perceptual quality estimate.
   * Weights: 40 % resolution, 30 % fps, 20 % network health, 10 % frame-drop penalty.
   */
  private computeQualityScore(
    stream:        Stream,
    frameDrop:     FrameDropStrategy | null,
    networkHealth: NetworkHealthAnalysis,
  ): number {
    const BASELINE_PIXELS = 1920 * 1080;
    const BASELINE_FPS    = 60;

    const resScore    = Math.min(1.0, (stream.widthPx * stream.heightPx) / BASELINE_PIXELS);
    const effectiveFps = frameDrop?.active ? frameDrop.effectiveFps : stream.fps;
    const fpsScore    = Math.min(1.0, effectiveFps / BASELINE_FPS);
    const healthScore = this.healthToScore(networkHealth.status);
    const dropPenalty = frameDrop?.active ? frameDrop.keepRatio : 1.0;

    const raw =
      resScore    * 0.40 +
      fpsScore    * 0.30 +
      healthScore * 0.20 +
      dropPenalty * 0.10;

    return Math.round(raw * 100);
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
