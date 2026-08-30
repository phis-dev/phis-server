"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type OperatorOverviewSnapshot = {
  collectedAt: string;
  osLabel: string;
  nodeVersion: string;
  nextVersion: string;
  reactVersion: string;
  cpuCount: number;
  load1: number;
  load5: number;
  load15: number;
  cpuUsageRatio: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  usedMemoryBytes: number;
  memoryUsageRatio: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  diskUsedBytes: number;
  diskUsageRatio: number;
  uptimeSeconds: number;
};

type OperatorOverviewDashboardProps = {
  initialSnapshot: OperatorOverviewSnapshot;
  labels: {
    title: string;
    os: string;
    node: string;
    next: string;
    react: string;
    cpuCard: string;
    memoryCard: string;
    diskCard: string;
    uptimeCard: string;
    cpuGraph: string;
    memoryGraph: string;
    diskGraph: string;
    loadDetail: string;
    usedDetail: string;
    freeDetail: string;
  };
};

const POLL_INTERVAL_MS = 15000;
const HISTORY_LIMIT = 24;

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatUptime(seconds: number) {
  const totalSeconds = Math.max(Math.floor(seconds), 0);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function formatSnapshotTime(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return "--:-- UTC";
  }

  return `${timestamp.toISOString().slice(11, 16)} UTC`;
}

function MetricGraph({ values }: { values: number[] }) {
  const normalizedValues = values.map((value) => Math.max(0, Math.min(1, value)));
  const width = 100;
  const height = 36;
  const slotWidth = width / HISTORY_LIMIT;
  const barWidth = Math.max(slotWidth * 0.38, 0.8);
  const startSlot = Math.max(HISTORY_LIMIT - normalizedValues.length, 0);

  return (
    <svg
      viewBox="0 0 100 36"
      preserveAspectRatio="none"
      className="operator-metric-graph"
      suppressHydrationWarning
    >
      <line x1="0" y1={height} x2={width} y2={height} className="operator-metric-graph_baseline" />
      {normalizedValues.map((value, index) => {
        const slotIndex = startSlot + index;
        const barHeight = Math.max(value * height, 0);
        const x = slotIndex * slotWidth + (slotWidth - barWidth) / 2;
        const y = height - barHeight;

        return (
          <rect
            key={`${index}-${value}`}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            rx={barWidth / 2}
            className="operator-metric-graph_bar"
          />
        );
      })}
    </svg>
  );
}

export function OperatorOverviewDashboard({
  initialSnapshot,
  labels,
}: OperatorOverviewDashboardProps) {
  const router = useRouter();
  const [history, setHistory] = useState<OperatorOverviewSnapshot[]>([initialSnapshot]);

  useEffect(() => {
    let cancelled = false;

    async function fetchSnapshot() {
      try {
        const response = await fetch("/api/operator/overview/metrics", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });

        if (!response.ok) {
          if (!cancelled) {
            router.refresh();
          }
          return;
        }

        const snapshot = (await response.json()) as OperatorOverviewSnapshot;
        if (cancelled) {
          return;
        }

        setHistory((current) => [...current, snapshot].slice(-HISTORY_LIMIT));
      } catch {
        if (!cancelled) {
          router.refresh();
        }
      }
    }

    const intervalId = window.setInterval(fetchSnapshot, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [router]);

  const current = history[history.length - 1] ?? initialSnapshot;
  const cpuHistory = useMemo(() => history.map((entry) => entry.cpuUsageRatio), [history]);
  const memoryHistory = useMemo(() => history.map((entry) => entry.memoryUsageRatio), [history]);
  const diskHistory = useMemo(() => history.map((entry) => entry.diskUsageRatio), [history]);

  return (
    <div className="operator-overview">
      <section className="ui_card">
        <p className="ui_section_eyebrow">Overview</p>
        <p className="ui_section_title">{labels.title}</p>
        <p className="ui_section_body">
          {labels.os}: {current.osLabel}
        </p>
        <p className="ui_section_body ui_runtime_meta">
          {labels.node}: {current.nodeVersion}
          {" · "}
          {labels.next}: {current.nextVersion}
          {" · "}
          {labels.react}: {current.reactVersion}
        </p>
      </section>

      <section className="operator-kpi-grid">
        <article className="ui_card operator-kpi">
          <p className="ui_section_eyebrow">{labels.cpuCard}</p>
          <p className="operator-kpi_value">{formatPercent(current.cpuUsageRatio)}</p>
          <p className="ui_section_body">
            {labels.loadDetail}: {current.load1.toFixed(2)} / {current.cpuCount}
          </p>
        </article>

        <article className="ui_card operator-kpi">
          <p className="ui_section_eyebrow">{labels.memoryCard}</p>
          <p className="operator-kpi_value">{formatPercent(current.memoryUsageRatio)}</p>
          <p className="ui_section_body">
            {labels.usedDetail}: {formatBytes(current.usedMemoryBytes)}
          </p>
        </article>

        <article className="ui_card operator-kpi">
          <p className="ui_section_eyebrow">{labels.diskCard}</p>
          <p className="operator-kpi_value">{formatBytes(current.diskFreeBytes)}</p>
          <p className="ui_section_body">
            {labels.freeDetail}: {formatPercent(1 - current.diskUsageRatio)}
          </p>
        </article>

        <article className="ui_card operator-kpi">
          <p className="ui_section_eyebrow">{labels.uptimeCard}</p>
          <p className="operator-kpi_value">{formatUptime(current.uptimeSeconds)}</p>
          <p className="ui_section_body" suppressHydrationWarning>
            {formatSnapshotTime(current.collectedAt)}
          </p>
        </article>
      </section>

      <section className="operator-chart-grid">
        <article className="ui_card operator-chart">
          <p className="ui_section_eyebrow">{labels.cpuGraph}</p>
          <p className="operator-chart_value">{formatPercent(current.cpuUsageRatio)}</p>
          <MetricGraph values={cpuHistory} />
        </article>

        <article className="ui_card operator-chart">
          <p className="ui_section_eyebrow">{labels.memoryGraph}</p>
          <p className="operator-chart_value">{formatBytes(current.usedMemoryBytes)}</p>
          <MetricGraph values={memoryHistory} />
        </article>

        <article className="ui_card operator-chart">
          <p className="ui_section_eyebrow">{labels.diskGraph}</p>
          <p className="operator-chart_value">{formatBytes(current.diskFreeBytes)}</p>
          <MetricGraph values={diskHistory} />
        </article>
      </section>
    </div>
  );
}
