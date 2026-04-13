// ─────────────────────────────────────────────────────────────────────────────
// QoSAnalyzer.ts  –  Converts raw QoS metrics into an effective bandwidth figure
// ─────────────────────────────────────────────────────────────────────────────

import { NetworkQoS, NetworkHealthAnalysis, NetworkHealthStatus } from './types.js';

/**
 * Translates raw QoS measurements (bandwidth, latency, jitter, packet loss)
 * into an effective bandwidth value and a health label.
 *
 * Design rationale
 * ─────────────────
 * Raw bandwidth alone is a misleading input for stream selection because:
 *
 *  • Packet loss forces TCP retransmissions that consume extra bandwidth and
 *    cause bursty throughput reduction. A 5 % loss rate can halve real
 *    throughput on a TCP-based stream.
 *
 *  • High jitter means instantaneous bandwidth swings greatly around the
 *    average. A player's jitter buffer must absorb these swings, so the
 *    sustained usable bandwidth is lower than the measured average.
 *
 *  • Elevated RTT is a leading indicator of buffer bloat / congestion that
 *    will materialise as bandwidth reduction within the next few seconds.
 *
 * The analyzer applies multiplicative penalty factors for each condition and
 * caps the effective bandwidth at (raw × combinedPenalty).
 */
export class QoSAnalyzer {
  analyze(qos: NetworkQoS): NetworkHealthAnalysis {
    this.validateInput(qos);

    const issues: string[] = [];
    let penaltyFactor = 1.0;

    // ── 1. Packet-loss penalty ────────────────────────────────────────────────
    // Model: each 1 % loss amplifies effective bandwidth reduction by 1.5×
    // because lost packets on CBR video streams cause decoder stalls that
    // back-pressure the send window (TCP) or require FEC retransmits (RTP/QUIC).
    // Floor: 0.10 (never reduce below 10 % of raw bandwidth).
    if (qos.packetLossPercent > 0) {
      const rawLossFraction  = qos.packetLossPercent / 100;
      const amplifiedPenalty = Math.min(0.90, rawLossFraction * 1.5);
      penaltyFactor *= Math.max(0.10, 1 - amplifiedPenalty);

      if      (qos.packetLossPercent >= 10) issues.push(`Critical packet loss: ${qos.packetLossPercent.toFixed(1)}%`);
      else if (qos.packetLossPercent >=  5) issues.push(`High packet loss: ${qos.packetLossPercent.toFixed(1)}%`);
      else if (qos.packetLossPercent >=  2) issues.push(`Elevated packet loss: ${qos.packetLossPercent.toFixed(1)}%`);
      else                                  issues.push(`Minor packet loss: ${qos.packetLossPercent.toFixed(1)}%`);
    }

    // ── 2. Jitter penalty ─────────────────────────────────────────────────────
    // Up to 20 ms: negligible.
    // 20–50 ms: mild – 0–5 % penalty.
    // 50–150 ms: significant – 5–15 % penalty.
    // >150 ms: severe – up to 30 % penalty (capped).
    if (qos.jitterMs > 20) {
      let jitterPenalty: number;
      if (qos.jitterMs <= 50) {
        jitterPenalty = ((qos.jitterMs - 20) / 30) * 0.05;
        issues.push(`Moderate jitter: ${qos.jitterMs}ms`);
      } else if (qos.jitterMs <= 150) {
        jitterPenalty = 0.05 + ((qos.jitterMs - 50) / 100) * 0.10;
        issues.push(`High jitter: ${qos.jitterMs}ms`);
      } else {
        jitterPenalty = Math.min(0.30, 0.15 + ((qos.jitterMs - 150) / 500) * 0.15);
        issues.push(`Severe jitter: ${qos.jitterMs}ms`);
      }
      penaltyFactor *= 1 - jitterPenalty;
    }

    // ── 3. Latency / congestion penalty ──────────────────────────────────────
    // RTT > 100 ms: mild network load – up to 5 % penalty.
    // RTT > 200 ms: moderate congestion – up to 15 % penalty.
    // RTT > 400 ms: severe congestion – up to 20 % penalty (capped).
    if (qos.latencyMs > 100) {
      let latencyPenalty: number;
      if (qos.latencyMs <= 200) {
        latencyPenalty = ((qos.latencyMs - 100) / 100) * 0.05;
        issues.push(`Elevated latency: ${qos.latencyMs}ms`);
      } else if (qos.latencyMs <= 400) {
        latencyPenalty = 0.05 + ((qos.latencyMs - 200) / 200) * 0.10;
        issues.push(`High latency: ${qos.latencyMs}ms`);
      } else {
        latencyPenalty = Math.min(0.20, 0.15 + ((qos.latencyMs - 400) / 1000) * 0.05);
        issues.push(`Very high latency: ${qos.latencyMs}ms`);
      }
      penaltyFactor *= 1 - latencyPenalty;
    }

    // Clamp to a sensible range
    penaltyFactor = Math.max(0.05, Math.min(1.0, penaltyFactor));

    const effectiveBandwidthKbps = Math.floor(qos.bandwidthKbps * penaltyFactor);
    const status = this.classifyHealth(qos, penaltyFactor);

    return { status, effectiveBandwidthKbps, bandwidthPenaltyFactor: penaltyFactor, issues };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private classifyHealth(qos: NetworkQoS, penaltyFactor: number): NetworkHealthStatus {
    if (qos.packetLossPercent >= 10 || penaltyFactor < 0.45) return NetworkHealthStatus.CRITICAL;
    if (qos.packetLossPercent >=  5 || qos.jitterMs > 100 || qos.latencyMs > 350) return NetworkHealthStatus.POOR;
    if (qos.packetLossPercent >=  2 || qos.jitterMs >  50 || qos.latencyMs > 150) return NetworkHealthStatus.FAIR;
    if (qos.packetLossPercent >   0 || qos.jitterMs >  20 || qos.latencyMs >  80) return NetworkHealthStatus.GOOD;
    return NetworkHealthStatus.EXCELLENT;
  }

  private validateInput(qos: NetworkQoS): void {
    if (qos.bandwidthKbps < 0)
      throw new RangeError(`bandwidthKbps must be ≥ 0, got ${qos.bandwidthKbps}`);
    if (qos.latencyMs < 0)
      throw new RangeError(`latencyMs must be ≥ 0, got ${qos.latencyMs}`);
    if (qos.jitterMs < 0)
      throw new RangeError(`jitterMs must be ≥ 0, got ${qos.jitterMs}`);
    if (qos.packetLossPercent < 0 || qos.packetLossPercent > 100)
      throw new RangeError(`packetLossPercent must be in [0, 100], got ${qos.packetLossPercent}`);
  }
}
