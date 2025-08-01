import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import * as fs from 'fs/promises'
import * as path from 'path'
import { Logger } from 'koishi'
import { Config } from './index'

/**
 * @class FileManager
 * @description 封装了对文件的存储、读取和删除操作。
 * 能根据配置自动选择使用本地文件系统或 AWS S3 作为存储后端。
 * 内置 Promise 文件锁，防止本地文件的并发写入冲突。
 */
export class FileManager {
  private resourceDir: string;
  private locks = new Map<string, Promise<any>>();
  private s3Client?: S3Client;
  private s3Bucket?: string;

  /**
   * @constructor
   * @param baseDir Koishi 应用的基础数据目录 (ctx.baseDir)。
   * @param config 插件的配置对象。
   * @param logger 日志记录器实例。
   */
  constructor(baseDir: string, config: Config, private logger: Logger) {
    // 统一将资源文件存储在 Koishi data 目录的 'cave' 子目录中。
    this.resourceDir = path.join(baseDir, 'data', 'cave');

    // 若启用 S3 且关键信息完整，则初始化 S3 客户端。
    if (config.enableS3 && config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey) {
      this.s3Client = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
      this.s3Bucket = config.bucket;
    }
  }

  /**
   * @description 使用文件锁安全地执行异步文件操作，防止并发读写冲突。
   * @template T 异步操作的返回类型。
   * @param fullPath 需要加锁的文件的完整路径。
   * @param operation 要执行的异步函数。
   * @returns 返回异步操作的结果。
   */
  private async withLock<T>(fullPath: string, operation: () => Promise<T>): Promise<T> {
    // 等待已有的锁完成。
    while (this.locks.has(fullPath)) {
      await this.locks.get(fullPath);
    }
    // 创建新锁并立即执行操作，确保操作完成后释放锁。
    const promise = operation().finally(() => {
      this.locks.delete(fullPath);
    });
    this.locks.set(fullPath, promise);
    return promise;
  }

  /**
   * @description 保存文件，自动选择 S3 或本地存储。
   * @param fileName 用作 S3 Key 或本地文件名。
   * @param data 要写入的 Buffer 数据。
   * @returns 返回保存时使用的文件名/标识符。
   */
  public async saveFile(fileName: string, data: Buffer): Promise<string> {
    if (this.s3Client) {
      // S3 存储
      const command = new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: fileName,
        Body: data,
        ACL: 'public-read', // 默认为公开可读
      });
      await this.s3Client.send(command);
    } else {
      // 本地存储
      await fs.mkdir(this.resourceDir, { recursive: true }).catch(error => {
          this.logger.error(`创建资源目录失败 ${this.resourceDir}:`, error);
          throw error;
      });
      const filePath = path.join(this.resourceDir, fileName);
      await this.withLock(filePath, () => fs.writeFile(filePath, data));
    }
    return fileName;
  }

  /**
   * @description 读取文件，自动从 S3 或本地存储读取。
   * @param fileName 要读取的文件名/标识符。
   * @returns 文件的 Buffer 数据。
   */
  public async readFile(fileName: string): Promise<Buffer> {
    if (this.s3Client) {
      // S3 读取
      const command = new GetObjectCommand({ Bucket: this.s3Bucket, Key: fileName });
      const response = await this.s3Client.send(command);
      // S3 Body 是一个 ReadableStream，需转换为 Buffer。
      return Buffer.from(await response.Body.transformToByteArray());
    } else {
      // 本地读取
      const filePath = path.join(this.resourceDir, fileName);
      return this.withLock(filePath, () => fs.readFile(filePath));
    }
  }

  /**
   * @description 删除文件，自动从 S3 或本地删除。
   * @param fileIdentifier 要删除的文件名/标识符。
   */
  public async deleteFile(fileIdentifier: string): Promise<void> {
    if (this.s3Client) {
      // S3 删除
      const command = new DeleteObjectCommand({ Bucket: this.s3Bucket, Key: fileIdentifier });
      await this.s3Client.send(command).catch(err => {
        this.logger.warn(`删除 S3 文件 ${fileIdentifier} 失败:`, err);
      });
    } else {
      // 本地删除
      const filePath = path.join(this.resourceDir, fileIdentifier);
      await this.withLock(filePath, async () => {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          // 如果文件已不存在(ENOENT)，则忽略错误，保证操作幂等性。
          if (error.code !== 'ENOENT') {
            this.logger.warn(`删除本地文件 ${filePath} 失败:`, error);
          }
        }
      });
    }
  }
}
