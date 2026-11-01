import { api } from "./api.ts";
import type { Run } from "./types.ts";

type PollOptions = {
  isActive?: () => boolean;
  onProgress?: (run: Run) => void;
  onUnavailable?: (message: string | null) => void;
  intervalMs?: number;
  requestTimeoutMs?: number;
};

/** Only a server terminal state ends an accepted, potentially paid run. */
export async function waitForRun(runId: string, options: PollOptions = {}): Promise<Run | null> {
  const isActive = options.isActive ?? (() => true);
  let unavailable: string | null = null;
  while (isActive()) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
    if (!isActive()) return null;
    let status: Run;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 15000);
    try {
      status = await api<Run>(`/api/runs/${encodeURIComponent(runId)}`, { signal: controller.signal });
    } catch (cause) {
      if (!isActive()) return null;
      const detail = cause instanceof Error ? cause.message : "暂时无法连接服务";
      const message = `暂时无法读取运行状态（${detail}）。正在继续查询，请勿重复提交；也可从运行记录核对。`;
      if (message !== unavailable) options.onUnavailable?.(message);
      unavailable = message;
      continue;
    } finally {
      clearTimeout(timeout);
    }
    if (!isActive()) return null;
    if (unavailable !== null) options.onUnavailable?.(null);
    unavailable = null;
    options.onProgress?.(status);
    if (status.status === "succeeded" || status.status === "failed") return status;
  }
  return null;
}
