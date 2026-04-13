// ─────────────────────────────────────────────────────────────────────────────
// FrameDropCalculator.ts  –  Computes a periodic frame-drop pattern
// ─────────────────────────────────────────────────────────────────────────────

import { Stream, FrameDropStrategy } from './types.js';

/**
 * Calculates the minimal, most uniform frame-dropping pattern that brings a
 * stream's effective bitrate within the available bandwidth budget.
 *
 * Used exclusively by FPS_PRIORITY as a last resort when no stream fits.
 * RESOLUTION_PRIORITY never activates frame dropping.
 *
 * Why a periodic pattern?
 * ───────────────────────
 * A periodic drop (keep every Nth frame) is the simplest filter a packet
 * pipeline can implement: maintain a per-stream frame counter; forward a
 * frame when (counter % dropEveryNthFrame === 0). It is deterministic,
 * stateless between decisions, and avoids decoder artifacts.
 * The caller is responsible for not dropping IDR/keyframes.
 *
 * Bitrate linearity assumption
 * ─────────────────────────────
 * Dropping 1 out of every N frames reduces bitrate by approximately 1/N for
 * CBR streams and streams with a constant GOP structure. For VBR streams the
 * relationship is approximate but remains a safe lower bound — the actual
 * saved bitrate may be slightly lower (I-frames are larger), so the 20 %
 * safety margin applied upstream provides the necessary headroom.
 */
export class FrameDropCalculator {
  /**
   * @param stream                  The stream to potentially drop frames from.
   * @param effectiveBandwidthKbps  Usable bandwidth AFTER the safety margin has
   *                                already been subtracted by StreamSelector.
   */
  calculate(stream: Stream, effectiveBandwidthKbps: number): FrameDropStrategy {
    // No dropping needed
    if (stream.bitrateKbps <= effectiveBandwidthKbps) {
      return {
        active: false,
        dropEveryNthFrame: 1,
        keepRatio: 1.0,
        effectiveFps: stream.fps,
        effectiveBitrateKbps: stream.bitrateKbps,
        reason: 'Stream fits within available bandwidth – no frame dropping required.',
      };
    }

    // Bandwidth is zero or near-zero – maximum drop
    if (effectiveBandwidthKbps <= 0) {
      return {
        active: true,
        dropEveryNthFrame: Math.ceil(stream.fps),
        keepRatio: 1 / Math.ceil(stream.fps),
        effectiveFps: 1,
        effectiveBitrateKbps: Math.floor(stream.bitrateKbps / Math.ceil(stream.fps)),
        reason: 'Zero effective bandwidth – applying maximum frame drop (1 fps).',
      };
    }

    // ── Core calculation ─────────────────────────────────────────────────────
    //
    // We want: effectiveBitrate ≤ effectiveBandwidthKbps
    // effectiveBitrate = stream.bitrateKbps × (1 / dropEveryNthFrame)
    //
    // So:  dropEveryNthFrame ≥ stream.bitrateKbps / effectiveBandwidthKbps
    //
    // ceil() guarantees we stay *under* budget.
    const rawN             = stream.bitrateKbps / effectiveBandwidthKbps;
    const dropEveryNthFrame = Math.ceil(rawN);

    const keepRatio             = 1 / dropEveryNthFrame;
    const effectiveFps          = parseFloat((stream.fps * keepRatio).toFixed(2));
    const effectiveBitrateKbps  = Math.floor(stream.bitrateKbps * keepRatio);
    const pct                   = Math.round(keepRatio * 100);

    return {
      active: true,
      dropEveryNthFrame,
      keepRatio,
      effectiveFps,
      effectiveBitrateKbps,
      reason:
        `Bandwidth ${effectiveBandwidthKbps} Kbps < required ${stream.bitrateKbps} Kbps. ` +
        `Keeping every ${this.ordinal(dropEveryNthFrame)} frame (${pct}% of frames) → ` +
        `~${effectiveFps} fps @ ~${effectiveBitrateKbps} Kbps.`,
    };
  }

  private ordinal(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
  }
}
