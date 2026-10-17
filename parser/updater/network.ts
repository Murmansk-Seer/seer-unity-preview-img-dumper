import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { setTimeout as sleep } from "node:timers/promises";

export const MAX_ATTEMPTS = 3;
export const REQUEST_TIMEOUT_MS = 30_000;
export const ATTEMPT_DEADLINE_MS = 60_000;

export class DownloadIntegrityError extends Error {}

/** One retry boundary for version, manifest and resource requests (never nested). */
export async function requestWithRetry<T>(
  client: AxiosInstance,
  config: AxiosRequestConfig,
  validate?: (response: AxiosResponse<T>) => void,
  retryDelayMs = 1000
): Promise<AxiosResponse<T>> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Axios timeout bounds idle sockets; a separate deadline bounds slow-drip data.
    const deadline = AbortSignal.timeout(ATTEMPT_DEADLINE_MS);
    const signal = config.signal
      ? AbortSignal.any([config.signal as AbortSignal, deadline])
      : deadline;
    try {
      const response = await client.request<T>({
        ...config,
        timeout: Math.min(config.timeout || REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS),
        signal,
      });
      validate?.(response);
      return response;
    } catch (error) {
      if (config.signal?.aborted) throw error;
      const retryable = deadline.aborted || error instanceof DownloadIntegrityError || (
        axios.isAxiosError(error) && (
          (!error.response && ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ERR_NETWORK", "ERR_BAD_RESPONSE"].includes(error.code || "")) ||
          error.response?.status === 408 || error.response?.status === 429 ||
          (error.response?.status || 0) >= 500
        )
      );
      if (!retryable || attempt === MAX_ATTEMPTS) throw error;
      console.warn(`Network request failed (${attempt}/${MAX_ATTEMPTS}); retrying: ${config.url}`);
      await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error("Unreachable retry state");
}
