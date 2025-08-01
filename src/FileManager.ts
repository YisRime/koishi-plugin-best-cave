import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from 'koishi';
import { Config } from './index';

/**
 * @class FileManager
 * @description 对文件资源的存储、读取和删除操作。
 * 内置了基于 Promise 的文件锁，以防止对本地文件的并发写入冲突。
 */
export class FileManager {
  private resourceDir: string;
  private locks = new Map<string, Promise<any>>();
  private s3Client?: S3Client;
  private s3Bucket?: string;

  /**
   * @param baseDir - Koishi 应用的基础数据目录 (ctx.baseDir)。
   * @param config - 插件的配置对象。
   * @param logger - 日志记录器实例。
   */
  constructor(baseDir: string, config: Config, private logger: Logger) {
    this.resourceDir = path.join(baseDir, 'data', 'cave');

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
   * 确保本地资源目录存在，若不存在则以递归方式创建。
   * @private
   */
  private async ensureDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.resourceDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Failed to create resource directory ${this.resourceDir}:`, error);
      throw error;
    }
  }

  /**
   * 获取给定文件名的完整本地路径。
   * @param fileName - 文件名。
   * @returns 文件的绝对路径。
   * @private
   */
  private getFullPath(fileName: string): string {
    return path.join(this.resourceDir, fileName);
  }

  /**
   * 使用文件锁安全地执行一个异步文件操作，防止对同一文件的并发访问。
   * @template T - 异步操作的返回类型。
   * @param fileName - 需要加锁的文件名。
   * @param operation - 要执行的异步函数。
   * @returns 返回异步操作的结果。
   * @private
   */
  private async withLock<T>(fileName: string, operation: () => Promise<T>): Promise<T> {
    const fullPath = this.getFullPath(fileName);

    // 等待已存在的锁释放
    while (this.locks.has(fullPath)) {
      await this.locks.get(fullPath).catch(() => {}); // 忽略上一个操作的错误
    }

    const promise = operation();
    this.locks.set(fullPath, promise);

    try {
      return await promise;
    } finally {
      if (this.locks.get(fullPath) === promise) {
        this.locks.delete(fullPath);
      }
    }
  }

  /**
   * 保存文件，自动路由到 S3 或本地存储。
   * @param fileName - 文件名，将用作 S3 Key 或本地文件名。
   * @param data - 要写入的 Buffer 数据。
   * @returns 返回保存时使用的文件名。
   */
  public async saveFile(fileName: string, data: Buffer): Promise<string> {
    if (this.s3Client) {
      const command = new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: fileName,
        Body: data,
        ACL: 'public-read',
      });
      await this.s3Client.send(command);
    } else {
      await this.ensureDirectory();
      const filePath = this.getFullPath(fileName);
      await this.withLock(fileName, () => fs.writeFile(filePath, data));
    }
    return fileName;
  }

  /**
   * 读取文件，自动从 S3 或本地存储获取。
   * @param fileName - 要读取的文件名。
   * @returns 文件的 Buffer 数据。
   */
  public async readFile(fileName: string): Promise<Buffer> {
    if (this.s3Client) {
      const command = new GetObjectCommand({
        Bucket: this.s3Bucket,
        Key: fileName,
      });
      const response = await this.s3Client.send(command);
      const byteArray = await response.Body.transformToByteArray();
      return Buffer.from(byteArray);
    } else {
      const filePath = this.getFullPath(fileName);
      return this.withLock(fileName, () => fs.readFile(filePath));
    }
  }

  /**
   * 删除文件，自动从 S3 或本地存储删除。
   * @param fileName - 要删除的文件名。
   */
  public async deleteFile(fileName: string): Promise<void> {
    if (this.s3Client) {
      const command = new DeleteObjectCommand({
        Bucket: this.s3Bucket,
        Key: fileName,
      });
      await this.s3Client.send(command).catch(err => {
        this.logger.warn(`删除文件 ${fileName} 失败:`, err)
      })
    } else {
      const filePath = this.getFullPath(fileName);
      await this.withLock(fileName, async () => {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          // 如果文件不存在 (ENOENT)，则忽略错误。
          if (error.code !== 'ENOENT') {
            this.logger.warn(`删除文件 ${fileName} 失败:`, error);
          }
        }
      });
    }
  }
}
