import { Injectable } from '@nestjs/common';

type Labels = Record<string, string | number>;

const HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

type HistogramSeries = {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
};

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}="${String(labels[name]).replace(/["\\\n]/g, '_')}"`)
    .join(',');
}

function line(name: string, labels: Labels, value: number): string {
  const serialized = labelKey(labels);
  return `${name}${serialized ? `{${serialized}}` : ''} ${value}`;
}

/**
 * Dependency-free Prometheus text exposition (architecture plan §4.6).
 *
 * A full metrics SDK is deliberately not used: the surface required here is
 * counters and latency histograms, and an in-process registry avoids a second
 * HTTP server or a push gateway. Metrics are per instance; the scrape layer is
 * expected to aggregate across replicas.
 */
@Injectable()
export class TelemetryService {
  private readonly counters = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map();
    const key = labelKey(labels);
    const current = series.get(key);
    series.set(key, { labels, value: (current?.value ?? 0) + by });
    this.counters.set(name, series);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const series = this.histograms.get(name) ?? new Map();
    const key = labelKey(labels);
    const entry =
      series.get(key) ??
      ({ labels, counts: HISTOGRAM_BUCKETS.map(() => 0), sum: 0, count: 0 } as HistogramSeries);

    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i += 1) {
      if (value <= HISTOGRAM_BUCKETS[i]) entry.counts[i] += 1;
    }
    series.set(key, entry);
    this.histograms.set(name, series);
  }

  render(): string {
    const lines: string[] = [];

    for (const [name, series] of [...this.counters.entries()].sort()) {
      lines.push(`# TYPE ${name} counter`);
      for (const entry of [...series.values()].sort((a, b) =>
        labelKey(a.labels).localeCompare(labelKey(b.labels)),
      )) {
        lines.push(line(name, entry.labels, entry.value));
      }
    }

    for (const [name, series] of [...this.histograms.entries()].sort()) {
      lines.push(`# TYPE ${name} histogram`);
      for (const entry of [...series.values()].sort((a, b) =>
        labelKey(a.labels).localeCompare(labelKey(b.labels)),
      )) {
        HISTOGRAM_BUCKETS.forEach((bucket, index) => {
          // Buckets are cumulative: every observation <= bucket is counted.
          lines.push(
            line(`${name}_bucket`, { ...entry.labels, le: bucket }, entry.counts[index]),
          );
        });
        lines.push(
          line(`${name}_bucket`, { ...entry.labels, le: '+Inf' }, entry.count),
        );
        lines.push(line(`${name}_sum`, entry.labels, entry.sum));
        lines.push(line(`${name}_count`, entry.labels, entry.count));
      }
    }

    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}
