import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import * as fs from 'fs/promises'
import * as path from 'path'
import { Logger } from 'koishi'
import { Config } from './index'

/**
 * 文件管理器 (FileManager)
 * @description
 * 封装了对文件（资源）的存储、读取和删除操作。
 * 它能够根据插件配置自动选择使用本地文件系统或 AWS S3 作为存储后端。
 * 内置了基于 Promise 的文件锁，以防止对本地文件的并发写入冲突。
 */
export class FileManager {
  // 本地资源存储目录的绝对路径。
  private resourceDir: string
  // 本地文件锁，键为文件绝对路径，值为一个 Promise，用于防止对同一文件的并发访问。
  private locks = new Map<string, Promise<any>>()
  // S3 客户端实例，仅在启用 S3 时初始化。
  private s3Client?: S3Client
  // S3 存储桶名称。
  private s3Bucket?: string

  /**
   * 创建一个 FileManager 实例。
   * @param baseDir - Koishi 应用的基础数据目录 (ctx.baseDir)。
   * @param config - 插件的完整配置对象。
   * @param logger - 日志记录器实例。
   */
  constructor(baseDir: string, config: Config, private logger: Logger) {
    // 所有资源文件都统一存储在 Koishi data 目录下的 'cave' 子目录中。
    this.resourceDir = path.join(baseDir, 'data', 'cave')

    // 如果配置中启用了 S3 并且关键信息齐全，则初始化 S3 客户端。
    if (config.enableS3 && config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey) {
      this.s3Client = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      })
      this.s3Bucket = config.bucket
    }
  }

  /**
   * 确保本地资源目录存在。如果目录不存在，则会递归创建。
   * 这是一个幂等操作。
   * @private
   */
  private async ensureDirectory(): Promise<void> {
    try {
      // recursive: true 选项使得当父目录不存在时会自动创建。
      await fs.mkdir(this.resourceDir, { recursive: true })
    } catch (error) {
      this.logger.error(`创建资源目录失败 ${this.resourceDir}:`, error)
      throw error // 抛出错误以中断后续操作
    }
  }

  /**
   * 获取给定文件名的完整本地路径。
   * @param fileName - 文件名。
   * @returns 文件的绝对路径。
   * @private
   */
  private getFullPath(fileName: string): string {
    return path.join(this.resourceDir, fileName)
  }

  /**
   * 使用文件锁来安全地执行一个异步文件操作。
   * 这可以防止对同一文件的并发读写造成数据损坏。
   * @template T - 异步操作的返回类型。
   * @param fileName - 需要加锁的文件名。
   * @param operation - 要执行的异步函数。
   * @returns 返回异步操作的结果。
   * @private
   */
  private async withLock<T>(fileName: string, operation: () => Promise<T>): Promise<T> {
    const fullPath = this.getFullPath(fileName);

    // 检查该文件是否已经有锁。如果有，则等待上一个操作完成。
    // `while` 循环确保即使在等待期间有新的锁加入，也能正确排队。
    while (this.locks.has(fullPath)) {
      await this.locks.get(fullPath);
    }

    // 创建一个新的 Promise 作为锁，并立即执行操作。
    // `finally` 块确保无论操作成功还是失败，锁最终都会被释放。
    const promise = operation().finally(() => {
      this.locks.delete(fullPath);
    });

    // 将锁存入 Map 中。
    this.locks.set(fullPath, promise);
    return promise;
  }

  /**
   * 保存文件，自动选择 S3 或本地存储。
   * @param fileName - 文件名，将用作 S3 中的 Key 或本地文件名。
   * @param data - 要写入的 Buffer 数据。
   * @returns 返回保存时使用的文件名/标识符。
   */
  public async saveFile(fileName: string, data: Buffer): Promise<string> {
    if (this.s3Client) {
      // --- S3 存储模式 ---
      const command = new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: fileName,
        Body: data,
        ACL: 'public-read', // 默认将文件权限设置为公开可读，方便通过 URL 访问。
      });
      await this.s3Client.send(command);
      return fileName; // 返回文件名作为其在 S3 中的 Key。
    } else {
      // --- 本地存储模式 ---
      await this.ensureDirectory(); // 确保目录存在。
      const filePath = this.getFullPath(fileName);
      // 使用文件锁安全地写入文件。
      await this.withLock(fileName, () => fs.writeFile(filePath, data));
      return fileName; // 返回文件名作为本地标识符。
    }
  }

  /**
   * 读取文件，自动从 S3 或本地存储读取。
   * @param fileName - 要读取的文件名/标识符。
   * @returns 文件的 Buffer 数据。
   */
  public async readFile(fileName: string): Promise<Buffer> {
    if (this.s3Client) {
      // --- S3 存储模式 ---
      const command = new GetObjectCommand({
        Bucket: this.s3Bucket,
        Key: fileName,
      });
      const response = await this.s3Client.send(command);
      // S3 返回的 Body 是一个 ReadableStream，需要将其完整转换为字节数组，然后转为 Buffer。
      const byteArray = await response.Body.transformToByteArray();
      return Buffer.from(byteArray);
    } else {
      // --- 本地存储模式 ---
      const filePath = this.getFullPath(fileName);
      // 使用文件锁安全地读取文件，防止读取到写入一半的文件。
      return this.withLock(fileName, () => fs.readFile(filePath));
    }
  }

  /**
   * 删除文件，自动从 S3 或本地删除。
   * @param fileIdentifier - 要删除的文件名/标识符。
   */
  public async deleteFile(fileIdentifier: string): Promise<void> {
    if (this.s3Client) {
      // --- S3 存储模式 ---
      const command = new DeleteObjectCommand({
        Bucket: this.s3Bucket,
        Key: fileIdentifier,
      });
      // S3 删除操作如果失败（例如文件不存在），通常可以接受，因此只记录警告而不抛出错误。
      await this.s3Client.send(command).catch(err => {
        this.logger.warn(`删除文件 ${fileIdentifier} 失败:`, err)
      })
    } else {
      // --- 本地存储模式 ---
      const filePath = this.getFullPath(fileIdentifier);
      await this.withLock(fileIdentifier, async () => {
        try {
          await fs.unlink(filePath); // 删除本地文件。
        } catch (error) {
          // 如果错误码是 'ENOENT'，意味着文件已经不存在，这是可接受的，保证了操作的幂等性。
          if (error.code !== 'ENOENT') {
            this.logger.warn(`删除文件 ${filePath} 失败:`, error)
          }
        }
      });
    }
  }
}
