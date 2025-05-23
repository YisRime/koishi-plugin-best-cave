import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'koishi';

const logger = new Logger('fileHandler');

// 文件处理工具类
export class FileHandler {
  private static locks = new Map<string, Promise<any>>();
  private static readonly RETRY_COUNT = 3;
  private static readonly RETRY_DELAY = 1000;
  private static readonly CONCURRENCY_LIMIT = 5;

  /**
   * 并发控制
   * @param operation 要执行的操作
   * @param limit 并发限制
   * @returns 操作结果
   */
  private static async withConcurrencyLimit<T>(
    operation: () => Promise<T>,
    limit = this.CONCURRENCY_LIMIT
  ): Promise<T> {
    while (this.locks.size >= limit) {
      await Promise.race(this.locks.values());
    }
    return operation();
  }

  /**
   * 文件操作包装器
   * @param filePath 文件路径
   * @param operation 要执行的操作
   * @returns 操作结果
   */
  private static async withFileOp<T>(
    filePath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = filePath;

    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    const operationPromise = (async () => {
      for (let i = 0; i < this.RETRY_COUNT; i++) {
        try {
          return await operation();
        } catch (error) {
          if (i === this.RETRY_COUNT - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
        }
      }
      throw new Error('Operation failed after retries');
    })();

    this.locks.set(key, operationPromise);
    try {
      return await operationPromise;
    } finally {
      this.locks.delete(key);
    }
  }

  /**
   * 事务处理
   * @param operations 要执行的操作数组
   * @returns 操作结果数组
   */
  static async withTransaction<T>(
    operations: Array<{
      filePath: string;
      operation: () => Promise<T>;
      rollback?: () => Promise<void>;
    }>
  ): Promise<T[]> {
    const results: T[] = [];
    const completed = new Set<string>();

    try {
      for (const {filePath, operation} of operations) {
        const result = await this.withFileOp(filePath, operation);
        results.push(result);
        completed.add(filePath);
      }
      return results;
    } catch (error) {
      await Promise.all(
        operations
          .filter(({filePath}) => completed.has(filePath))
          .map(async ({filePath, rollback}) => {
            if (rollback) {
              await this.withFileOp(filePath, rollback).catch(e =>
                logger.error(`Rollback failed for ${filePath}: ${e.message}`)
              );
            }
          })
      );
      throw error;
    }
  }

  /**
   * 读取 JSON 数据
   * @param filePath 文件路径
   * @returns JSON 数据
   */
  static async readJsonData<T>(filePath: string): Promise<T[]> {
    return this.withFileOp(filePath, async () => {
      try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(data || '[]');
      } catch (error) {
        return [];
      }
    });
  }

  /**
   * 写入 JSON 数据
   * @param filePath 文件路径
   * @param data 要写入的数据
   */
  static async writeJsonData<T>(filePath: string, data: T[]): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    await this.withFileOp(filePath, async () => {
      await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2));
      await fs.promises.rename(tmpPath, filePath);
    });
  }

  /**
   * 确保目录存在
   * @param dir 目录路径
   */
  static async ensureDirectory(dir: string): Promise<void> {
    await this.withConcurrencyLimit(async () => {
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
    });
  }

  /**
   * 确保 JSON 文件存在
   * @param filePath 文件路径
   */
  static async ensureJsonFile(filePath: string): Promise<void> {
    await this.withFileOp(filePath, async () => {
      if (!fs.existsSync(filePath)) {
        await fs.promises.writeFile(filePath, '[]', 'utf8');
      }
    });
  }

  /**
   * 保存媒体文件
   * @param filePath 文件路径
   * @param data 文件数据
   */
  static async saveMediaFile(
    filePath: string,
    data: Buffer | string
  ): Promise<void> {
    await this.withConcurrencyLimit(async () => {
      const dir = path.dirname(filePath);
      await this.ensureDirectory(dir);
      await this.withFileOp(filePath, () =>
        fs.promises.writeFile(filePath, data)
      );
    });
  }

  /**
   * 删除媒体文件
   * @param filePath 文件路径
   */
  static async deleteMediaFile(filePath: string): Promise<void> {
    await this.withFileOp(filePath, async () => {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    });
  }
}
