export interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  DISCORD_WEBHOOK_URL: string;
  ALERT_THRESHOLD_USD?: string;
}

interface TargetDates {
  yesterday: string;
  prevDay: string;
  monthStart: string;
  isPrevMonth: boolean;
  monthLabel: string;
}

interface BillableUsageRecord {
  ServiceName?: string;
  service_name?: string;
  ChargePeriodStart?: string;
  charge_period_start?: string;
  ContractedCost?: number | string;
  contracted_cost?: number | string;
  BillingCurrency?: string;
  billing_currency?: string;
}

interface CostSummary {
  currency: string;
  yesterdayCost: number;
  prevDayCost: number;
  monthlyCost: number;
  serviceBreakdown: Map<string, number>;
}

interface UsageTelemetry {
  workersRequests: number;
  r2StorageBytes: number;
  r2ClassAOps: number;
  r2ClassBOps: number;
}

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  timestamp: string;
  fields?: DiscordField[];
  footer?: { text: string };
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const COLOR_CLOUDFLARE = 0xf38020;
const COLOR_ALERT = 0xff0000;

const R2_CLASS_A_PREFIXES = ["Put", "Create", "Upload", "Complete", "List", "Copy"];
const R2_CLASS_B_PREFIXES = ["Get", "Head"];

function formatUtcDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatJapaneseDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${y}年${m}月${d}日`;
}

/** JST 基準で昨日・一昨日・集計開始日を算出する（毎月 1 日は前月累計にフォールバック） */
function computeTargetDates(now = new Date()): TargetDates {
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const jstTodayMidnightUtc = Date.UTC(
    jstNow.getUTCFullYear(),
    jstNow.getUTCMonth(),
    jstNow.getUTCDate(),
  );

  const yesterdayDate = new Date(jstTodayMidnightUtc - 24 * 60 * 60 * 1000);
  const prevDayDate = new Date(jstTodayMidnightUtc - 48 * 60 * 60 * 1000);
  const isFirstDayOfMonth = jstNow.getUTCDate() === 1;

  const monthStartDate = new Date(
    Date.UTC(yesterdayDate.getUTCFullYear(), yesterdayDate.getUTCMonth(), 1),
  );
  const yMonth = String(yesterdayDate.getUTCMonth() + 1).padStart(2, "0");

  return {
    yesterday: formatUtcDate(yesterdayDate),
    prevDay: formatUtcDate(prevDayDate),
    monthStart: formatUtcDate(monthStartDate),
    isPrevMonth: isFirstDayOfMonth,
    monthLabel: isFirstDayOfMonth
      ? `${yesterdayDate.getUTCFullYear()}年${yMonth}月 累計`
      : `今月の累計 (${yMonth}月01日〜)`,
  };
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatUsd(amount: number, signed = false): string {
  const abs = Math.abs(amount).toFixed(2);
  if (signed) {
    const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
    return `${sign}$${abs}`;
  }
  return amount < 0 ? `-$${abs}` : `$${abs}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function fetchBillableUsage(
  env: Env,
  dates: TargetDates,
): Promise<CostSummary> {
  // 前日比のため一昨日が前月にまたがる場合は from を早める
  const fromDate = dates.prevDay < dates.monthStart ? dates.prevDay : dates.monthStart;
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/billable-usage`,
  );
  url.searchParams.set("from", fromDate);
  url.searchParams.set("to", dates.yesterday);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Billable Usage API failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: BillableUsageRecord[] | { records?: BillableUsageRecord[] };
  };

  if (json.success === false) {
    const msg = json.errors?.map((e) => e.message).filter(Boolean).join(", ") || "Unknown API error";
    throw new Error(`Billable Usage API error: ${msg}`);
  }

  const records = Array.isArray(json.result)
    ? json.result
    : Array.isArray(json.result?.records)
      ? json.result.records
      : [];

  let currency = "USD";
  let yesterdayCost = 0;
  let prevDayCost = 0;
  let monthlyCost = 0;
  const serviceBreakdown = new Map<string, number>();

  for (const rec of records) {
    const recCurrency = rec.BillingCurrency || rec.billing_currency;
    if (recCurrency) currency = recCurrency;

    const periodStart = (rec.ChargePeriodStart || rec.charge_period_start || "").slice(0, 10);
    const cost = toNumber(rec.ContractedCost ?? rec.contracted_cost);
    const service = rec.ServiceName || rec.service_name || "Other";

    if (periodStart === dates.yesterday) {
      yesterdayCost += cost;
    }
    if (periodStart === dates.prevDay) {
      prevDayCost += cost;
    }
    if (periodStart >= dates.monthStart && periodStart <= dates.yesterday) {
      monthlyCost += cost;
      if (cost > 0) {
        serviceBreakdown.set(service, (serviceBreakdown.get(service) ?? 0) + cost);
      }
    }
  }

  return {
    currency,
    yesterdayCost,
    prevDayCost,
    monthlyCost,
    serviceBreakdown,
  };
}

function classifyR2Action(actionType: string): "A" | "B" | "free" {
  if (R2_CLASS_A_PREFIXES.some((p) => actionType.startsWith(p))) return "A";
  if (R2_CLASS_B_PREFIXES.some((p) => actionType.startsWith(p))) return "B";
  return "free";
}

async function fetchFreeTierTelemetry(
  env: Env,
  monthStart: string,
): Promise<UsageTelemetry | null> {
  const sinceIso = `${monthStart}T00:00:00Z`;
  const query = `
    query ($accountTag: string!, $sinceDate: Date!, $sinceTime: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            filter: { date_geq: $sinceDate }
            limit: 1000
          ) {
            sum {
              requests
            }
          }
          r2OperationsAdaptiveGroups(
            filter: { datetime_geq: $sinceTime }
            limit: 1000
          ) {
            dimensions {
              actionType
            }
            sum {
              requests
            }
          }
          r2StorageAdaptiveGroups(
            filter: { date_geq: $sinceDate }
            orderBy: [date_DESC]
            limit: 100
          ) {
            dimensions {
              date
            }
            max {
              payloadSize
              metadataSize
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: env.CF_ACCOUNT_ID,
          sinceDate: monthStart,
          sinceTime: sinceIso,
        },
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as {
      errors?: unknown[];
      data?: {
        viewer?: {
          accounts?: Array<{
            workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }>;
            r2OperationsAdaptiveGroups?: Array<{
              dimensions?: { actionType?: string };
              sum?: { requests?: number };
            }>;
            r2StorageAdaptiveGroups?: Array<{
              dimensions?: { date?: string };
              max?: { payloadSize?: number; metadataSize?: number };
            }>;
          }>;
        };
      };
    };

    const account = json.data?.viewer?.accounts?.[0];
    if (!account) return null;

    let workersRequests = 0;
    for (const row of account.workersInvocationsAdaptive ?? []) {
      workersRequests += row.sum?.requests ?? 0;
    }

    let r2ClassAOps = 0;
    let r2ClassBOps = 0;
    for (const row of account.r2OperationsAdaptiveGroups ?? []) {
      const action = row.dimensions?.actionType ?? "";
      const reqs = row.sum?.requests ?? 0;
      const kind = classifyR2Action(action);
      if (kind === "A") r2ClassAOps += reqs;
      else if (kind === "B") r2ClassBOps += reqs;
    }

    let r2StorageBytes = 0;
    const storageRows = account.r2StorageAdaptiveGroups ?? [];
    if (storageRows.length > 0) {
      const latestDate = storageRows[0].dimensions?.date;
      for (const row of storageRows) {
        if (row.dimensions?.date !== latestDate) break;
        r2StorageBytes += (row.max?.payloadSize ?? 0) + (row.max?.metadataSize ?? 0);
      }
    }

    return {
      workersRequests,
      r2StorageBytes,
      r2ClassAOps,
      r2ClassBOps,
    };
  } catch {
    return null;
  }
}

function buildReportEmbed(
  dates: TargetDates,
  cost: CostSummary,
  telemetry: UsageTelemetry | null,
  thresholdUsd: number,
): DiscordEmbed {
  const diff = cost.yesterdayCost - cost.prevDayCost;
  const changeSymbol = diff > 0 ? "📈" : diff < 0 ? "📉" : "➡️";
  const isAlert = cost.yesterdayCost > thresholdUsd || cost.monthlyCost > thresholdUsd;

  const breakdownLines = Array.from(cost.serviceBreakdown.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, amount]) => `- ${name}: ${formatUsd(amount)}`)
    .join("\n");

  const monthlyValue = breakdownLines
    ? `**${formatUsd(cost.monthlyCost)}**\n${breakdownLines}`
    : `**${formatUsd(cost.monthlyCost)}** (無料枠内)`;

  const fields: DiscordField[] = [
    {
      name: `📅 ${formatJapaneseDate(dates.yesterday)} の利用料金`,
      value: `**${formatUsd(cost.yesterdayCost)}**`,
      inline: true,
    },
    {
      name: `${changeSymbol} 前日比`,
      value: formatUsd(diff, true),
      inline: true,
    },
    {
      name: `📊 ${dates.monthLabel}`,
      value: monthlyValue,
      inline: false,
    },
  ];

  if (telemetry) {
    fields.push({
      name: "📦 今月の無料枠使用状況",
      value: [
        `Workers リクエスト: ${telemetry.workersRequests.toLocaleString("en-US")} 回 (無料枠: 10 万/日)`,
        `R2 ストレージ: ${formatBytes(telemetry.r2StorageBytes)} (無料枠: 10 GB/月)`,
        `R2 操作 (Class A / B): ${telemetry.r2ClassAOps.toLocaleString("en-US")} / ${telemetry.r2ClassBOps.toLocaleString("en-US")} (無料枠: 100 万 / 1,000 万)`,
      ].join("\n"),
      inline: false,
    });
  }

  if (isAlert) {
    fields.unshift({
      name: "⚠️ 課金発生アラート",
      value: `しきい値 (${formatUsd(thresholdUsd)}) を超える利用料金が検出されました`,
      inline: false,
    });
  }

  return {
    title: "🟧 Cloudflare 利用料金 日次レポート",
    color: isAlert ? COLOR_ALERT : COLOR_CLOUDFLARE,
    timestamp: new Date().toISOString(),
    fields,
    footer: {
      text: `Cloudflare Billable Usage API (${cost.currency}) | 反映に数時間のラグがある場合があります`,
    },
  };
}

async function sendDiscordEmbed(webhookUrl: string, embed: DiscordEmbed): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord Webhook failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.DISCORD_WEBHOOK_URL) {
      throw new Error("DISCORD_WEBHOOK_URL is not configured");
    }

    try {
      if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
        throw new Error("CF_API_TOKEN or CF_ACCOUNT_ID is not configured");
      }

      const thresholdUsd = toNumber(env.ALERT_THRESHOLD_USD ?? "0");
      const dates = computeTargetDates();
      const [cost, telemetry] = await Promise.all([
        fetchBillableUsage(env, dates),
        fetchFreeTierTelemetry(env, dates.monthStart),
      ]);

      const embed = buildReportEmbed(dates, cost, telemetry, thresholdUsd);
      await sendDiscordEmbed(env.DISCORD_WEBHOOK_URL, embed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("cloudflare-cost-notify error:", message);
      const errorEmbed: DiscordEmbed = {
        title: "❌ Cloudflare 請求額通知エラー",
        description: `エラーが発生しました: ${message}`,
        color: COLOR_ALERT,
        timestamp: new Date().toISOString(),
      };
      await sendDiscordEmbed(env.DISCORD_WEBHOOK_URL, errorEmbed);
      throw err;
    }
  },
};
