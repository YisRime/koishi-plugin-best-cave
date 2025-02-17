import { Logger } from 'koishi';
import * as fs from 'fs';
import * as path from 'path';
import { ImageHasher } from './ImageHasher';
import { FileHandler } from './fileHandler';
import crypto from 'crypto';

const logger = new Logger('HashStorage');

/**
 * 存储哈希值的数据接口
 * @interface HashData
 */
interface HashData {
  /** 图像哈希值记录 */
  imageHashes: Record<string, string[]>;
  /** 文本哈希值记录 */
  textHashes: Record<string, string[]>;
  /** 最后更新时间 */
  lastUpdated: string;
}

/**
 * 哈希存储管理类
 * @class HashStorage
 */
export class HashStorage {
  private readonly filePath: string;
  private readonly resourceDir: string;
  private readonly caveFilePath: string;
  private imageHashes = new Map<number, string[]>();
  private textHashes = new Map<number, string[]>();
  private initialized = false;

  /**
   * 创建哈希存储实例
   * @param caveDir - 回声洞数据目录路径
   */
  constructor(private readonly caveDir: string) {
    this.filePath = path.join(caveDir, 'hash.json');
    this.resourceDir = path.join(caveDir, 'resources');
    this.caveFilePath = path.join(caveDir, 'cave.json');
  }

  /**
   * 初始化哈希存储
   * @throws 初始化失败时抛出错误
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const hashData = await FileHandler.readJsonData<HashData>(this.filePath)
        .then(data => data[0])
        .catch(() => null);

      if (!hashData?.imageHashes) {
        await this.buildInitialHashes();
      } else {
        this.loadHashData(hashData);
        await this.updateMissingHashes();
      }

      this.initialized = true;
    } catch (error) {
      logger.error(`Hash storage initialization failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * 加载哈希数据
   * @param data - 要加载的哈希数据
   * @private
   */
  private loadHashData(data: HashData): void {
    this.imageHashes = new Map(Object.entries(data.imageHashes).map(([k, v]) => [Number(k), v]));
    this.textHashes = new Map(Object.entries(data.textHashes || {}).map(([k, v]) => [Number(k), v]));
  }

  /**
   * 更新指定回声洞的哈希值
   * @param caveId - 回声洞ID
   * @param type - 哈希类型（图像或文本）
   * @param content - 要计算哈希的内容
   */
  async updateHash(caveId: number, type: 'image' | 'text', content: Buffer | string): Promise<void> {
    if (!this.initialized) await this.initialize();

    try {
      const hash = type === 'image'
        ? await ImageHasher.calculateHash(content as Buffer)
        : HashStorage.hashText(content as string);

      const hashMap = type === 'image' ? this.imageHashes : this.textHashes;
      const existingHashes = hashMap.get(caveId) || [];
      hashMap.set(caveId, [...existingHashes, hash]);

      await this.saveHashes();
    } catch (error) {
      logger.error(`Failed to update ${type} hash for cave ${caveId}: ${error.message}`);
    }
  }

  /**
   * 查找重复项
   * @param type - 查找类型（图像或文本）
   * @param hashes - 要查找的哈希值数组
   * @param threshold - 相似度阈值，默认为1
   * @returns 匹配结果数组
   */
  async findDuplicates(type: 'image' | 'text', hashes: string[], threshold: number = 1): Promise<Array<{
    index: number;
    caveId: number;
    similarity: number;
  } | null>> {
    if (!this.initialized) await this.initialize();

    const hashMap = type === 'image' ? this.imageHashes : this.textHashes;
    const calculateSimilarity = type === 'image'
      ? ImageHasher.calculateSimilarity
      : (a: string, b: string) => a === b ? 1 : 0;

    return hashes.map((hash, index) => {
      let maxSimilarity = 0;
      let matchedCaveId = null;

      for (const [caveId, existingHashes] of hashMap.entries()) {
        for (const existingHash of existingHashes) {
          const similarity = calculateSimilarity(hash, existingHash);
          if (similarity >= threshold && similarity > maxSimilarity) {
            maxSimilarity = similarity;
            matchedCaveId = caveId;
            if (similarity === 1) break;
          }
        }
        if (maxSimilarity === 1) break;
      }

      return matchedCaveId ? { index, caveId: matchedCaveId, similarity: maxSimilarity } : null;
    });
  }

  /**
   * 清除指定回声洞的所有哈希值
   * @param caveId - 回声洞ID
   */
  async clearHashes(caveId: number): Promise<void> {
    if (!this.initialized) await this.initialize();
    this.imageHashes.delete(caveId);
    this.textHashes.delete(caveId);
    await this.saveHashes();
  }

  /**
   * 构建初始哈希值
   * @private
   */
  private async buildInitialHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    let processedCount = 0;
    const total = caveData.length;

    for (const cave of caveData) {
      await this.processCaveHashes(cave);
      await this.processCaveTextHashes(cave);
      processedCount++;

      if (processedCount % 100 === 0 || processedCount === total) {
        logger.info(`Processing caves: ${processedCount}/${total} (${Math.floor(processedCount / total * 100)}%)`);
      }
    }

    await this.saveHashes();
    logger.info(`Processed ${processedCount} caves with ${this.imageHashes.size} images and ${this.textHashes.size} texts`);
  }

  /**
   * 更新缺失的哈希值
   * @private
   */
  private async updateMissingHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    const missingImageCaves = caveData.filter(cave => !this.imageHashes.has(cave.cave_id));
    const missingTextCaves = caveData.filter(cave => !this.textHashes.has(cave.cave_id));
    const total = missingImageCaves.length + missingTextCaves.length;

    if (total > 0) {
      let processedCount = 0;

      for (const cave of missingImageCaves) {
        await this.processCaveHashes(cave);
        processedCount++;
        if (processedCount % 100 === 0 || processedCount === total) {
          logger.info(`Updating missing hashes: ${processedCount}/${total} (${Math.floor(processedCount / total * 100)}%)`);
        }
      }

      for (const cave of missingTextCaves) {
        await this.processCaveTextHashes(cave);
        processedCount++;
        if (processedCount % 100 === 0 || processedCount === total) {
          logger.info(`Updating missing hashes: ${processedCount}/${total} (${Math.floor(processedCount / total * 100)}%)`);
        }
      }

      await this.saveHashes();
      logger.info(`Updated ${missingImageCaves.length} missing images and ${missingTextCaves.length} missing texts`);
    }
  }

  /**
   * 处理单个回声洞的哈希值
   * @param cave - 回声洞数据
   * @private
   */
  private async processCaveHashes(cave: any): Promise<void> {
    const imgElements = cave.elements?.filter(el => el.type === 'img' && el.file) || [];
    if (imgElements.length === 0) return;

    try {
      const hashes = await Promise.all(imgElements.map(async el => {
        const filePath = path.join(this.resourceDir, el.file);
        return fs.existsSync(filePath)
          ? ImageHasher.calculateHash(await fs.promises.readFile(filePath))
          : null;
      }));

      const validHashes = hashes.filter(Boolean);
      if (validHashes.length) {
        this.imageHashes.set(cave.cave_id, validHashes);
        await this.saveHashes();
      }
    } catch (error) {
      logger.error(`Failed to process cave ${cave.cave_id}: ${error.message}`);
    }
  }

  private async processCaveTextHashes(cave: any): Promise<void> {
    const textElements = cave.elements?.filter(el => el.type === 'text' && el.content) || [];
    if (textElements.length === 0) return;

    try {
      const hashes = textElements.map(el => HashStorage.hashText(el.content));
      if (hashes.length) {
        this.textHashes.set(cave.cave_id, hashes);
      }
    } catch (error) {
      logger.error(`Failed to process text hashes for cave ${cave.cave_id}: ${error.message}`);
    }
  }

  /**
   * 保存哈希数据到文件
   * @private
   */
  private async saveHashes(): Promise<void> {
    try {
      const data: HashData = {
        imageHashes: Object.fromEntries(this.imageHashes),
        textHashes: Object.fromEntries(this.textHashes),
        lastUpdated: new Date().toISOString()
      };
      await FileHandler.writeJsonData(this.filePath, [data]);
    } catch (error) {
      logger.error(`Failed to save hash data: ${error.message}`);
      throw error;
    }
  }

  /**
   * 加载回声洞数据
   * @returns 回声洞数据数组
   * @private
   */
  private async loadCaveData(): Promise<any[]> {
    const data = await FileHandler.readJsonData(this.caveFilePath);
    return Array.isArray(data) ? data.flat() : [];
  }

  /**
   * 计算文本的哈希值
   * @param text - 要计算哈希的文本
   * @returns MD5哈希值
   */
  static hashText(text: string): string {
    return crypto.createHash('md5').update(text).digest('hex');
  }
}
