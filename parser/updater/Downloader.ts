import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import PQueue from "p-queue";
import cliProgress from "cli-progress";
import { DownloadParams, DownloadMethod } from "./types";
import { DownloadIntegrityError, requestWithRetry } from "./network";

export default class Downloader {
  private client: AxiosInstance;
  private semaphore: PQueue;

  constructor(clientConfig?: AxiosRequestConfig, limit: number = 10) {
    this.client = axios.create(clientConfig);
    this.semaphore = new PQueue({ concurrency: limit });
  }

  private async getStreamData(
    url: string,
    method: DownloadMethod = "GET",
    md5?: string,
    progressCallback?: (progress: number) => void
  ): Promise<Buffer> {
    const response = await requestWithRetry<ArrayBuffer>(this.client, {
      url, method, responseType: "arraybuffer",
      onDownloadProgress: ({ progress }) => {
        if (progress !== undefined) progressCallback?.(progress);
      },
    }, (res) => {
      if (md5 && crypto.createHash("md5").update(Buffer.from(res.data)).digest("hex") !== md5.toLowerCase()) {
        throw new DownloadIntegrityError(`MD5 check failed for ${url}`);
      }
    });
    return Buffer.from(response.data);
  }

  async download(
    params: DownloadParams,
    postprocess?: (data: Buffer) => Buffer,
    semaphore?: PQueue
  ) {
    const queue = semaphore || this.semaphore;
    return queue.add(async () => {
      const { url, filename, method = "GET", md5 } = params;
      const urlStr = typeof url === "string" ? url : url.toString();

      const dir = path.dirname(filename);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const progressBar = new cliProgress.SingleBar(
        { format: `${path.basename(filename)} | {bar} | {percentage}%` },
        cliProgress.Presets.shades_classic
      );
      progressBar.start(100, 0);

      try {
        const data = await this.getStreamData(urlStr, method, md5, (p) =>
          progressBar.update(Math.round(p * 100))
        );
        fs.writeFileSync(filename, postprocess ? postprocess(data) : data);
        progressBar.update(100);
      } finally {
        progressBar.stop();
      }
    });
  }

  async downloads(
    params: DownloadParams[],
    postprocess?: (data: Buffer) => Buffer,
    semaphore?: PQueue
  ) {
    const totalBar = new cliProgress.SingleBar(
      { format: `总进度 | {bar} | {percentage}% | {value}/{total} 文件` },
      cliProgress.Presets.shades_classic
    );
    totalBar.start(params.length, 0);
    const queue = semaphore || this.semaphore;
    let done = 0;

    try {
      await Promise.all(
        params.map((p) =>
          this.download(p, postprocess, queue).then(() => {
            done++;
            totalBar.update(done);
          })
        )
      );
    } finally {
      totalBar.stop();
    }
  }
}
