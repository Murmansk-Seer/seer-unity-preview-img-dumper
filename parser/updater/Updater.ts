import PQueue from "p-queue";
import * as fs from "fs";
import Downloader from "./Downloader";
import YooVersionManager from "./YooVersionManager";
import { DownloadParams } from "./types";

export default class Updater {
  constructor(
    private name: string,
    private desc: string,
    private versionManager: YooVersionManager,
    private downloader: Downloader,
    private postprocess?: (data: Buffer) => Buffer
  ) {}

  private log(msg: string) {
    console.log(`更新器[${this.name}]: ${msg}`);
  }

  /**
   * 检查并更新文件
   * @param semaphoreLimit 并发限制
   * @param includeKeywords 只下载包含这些关键字的文件（可选）
   */
  async update(semaphoreLimit?: number, includeKeywords?: string[]) {
    this.log("检查更新...");
    const remote = await this.versionManager.getRemoteManifest();
    const local = this.versionManager.loadLocalManifest();
    let filesToUpdate = Array.from(remote.items).filter(
      ([filename, item]) =>
        !fs.existsSync(filename) || local.items.get(filename)?.fileHash !== item.fileHash
    );

    if (includeKeywords && includeKeywords.length > 0) {
      filesToUpdate = filesToUpdate.filter(([filename]) => {
        return includeKeywords.some((keyword) =>
          filename.toLowerCase().includes(keyword.toLowerCase())
        );
      });

      this.log(`应用筛选条件: 包含关键字 ${includeKeywords.join(", ")}`);
      this.log(`筛选后需要更新的文件数量: ${filesToUpdate.length}`);

    } else {
      this.log(`需要更新文件数量: ${filesToUpdate.length}`);
    }

    if (filesToUpdate.length === 0) {
      this.versionManager.saveManifestToLocal(remote);
      return this.log("资源未变化");
    }

    const tasks: DownloadParams[] = filesToUpdate.map(([fn, item]) => ({
      url: item.remoteFilename,
      filename: fn,
      md5: item.fileHash,
    }));

    const semaphore = semaphoreLimit
      ? new PQueue({ concurrency: semaphoreLimit })
      : undefined;

    await this.downloader.downloads(tasks, this.postprocess, semaphore);
    this.versionManager.saveManifestToLocal(remote);
    this.log("更新完成");
  }

  async getVersionInfo() {
    return {
      local: this.versionManager.loadLocalVersion(),
      remote: await this.versionManager.getRemoteVersion(),
    };
  }
}
