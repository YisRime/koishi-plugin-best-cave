import { Logger } from 'koishi';
import * as fs from 'fs';
import * as path from 'path';
import { ImageHasher } from './ImageHasher';
import { FileHandler } from './fileHandler';
import { promisify } from 'util';

const logger = new Logger('HashStorage');
const readFileAsync = promisify(fs.readFile);

/**
 * 存储图片哈希值的数据结构
 */
interface HashData {
  /** 存储图片哈希值的记录，key为回声洞ID，value为哈希值数组 */
  hashes: Record<string, string[]>;
  /** 最后更新时间 */
  lastUpdated?: string;
}

/**
 * 哈希存储状态信息
 */
interface HashStatus {
  /** 最后更新时间戳 */
  lastUpdated: string;
  /** 所有回声洞的哈希值条目 */
  entries: Array<{ caveId: number; hashes: string[] }>;
}

/**
 * 图片哈希值存储管理类
 * 负责管理和维护回声洞图片的哈希值
 */
export class HashStorage {
  // 哈希数据文件名
  private static readonly HASH_FILE = 'hash.json';
  // 回声洞数据文件名
  private static readonly CAVE_FILE = 'cave.json';
  // 批处理大小
  private static readonly BATCH_SIZE = 50;
  // 存储回声洞ID到图片哈希值的映射
  private hashes = new Map<number, string[]>();
  // 初始化状态标志
  private initialized = false;

  /**
   * 初始化HashStorage实例
   * @param caveDir 回声洞数据目录路径
   */
  constructor(private readonly caveDir: string) {}

  private get filePath() {
    return path.join(this.caveDir, HashStorage.HASH_FILE);
  }

  private get resourceDir() {
    return path.join(this.caveDir, 'resources');
  }

  private get caveFilePath() {
    return path.join(this.caveDir, HashStorage.CAVE_FILE);
  }

  /**
   * 初始化哈希存储
   * 读取现有哈希数据或重新构建哈希值
   * @throws 初始化失败时抛出错误
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const hashData = await FileHandler.readJsonData<HashData>(this.filePath)
        .then(data => data[0])
        .catch(() => null);

      if (!hashData?.hashes || Object.keys(hashData.hashes).length === 0) {
        this.hashes.clear();
        await this.buildInitialHashes();
      } else {
        this.hashes = new Map(
          Object.entries(hashData.hashes).map(([k, v]) => [Number(k), v as string[]])
        );
        await this.updateMissingHashes();
      }

      this.initialized = true;
    } catch (error) {
      logger.error(`Initialization failed: ${error.message}`);
      this.initialized = false;
      throw error;
    }
  }

  /**
   * 获取当前哈希存储状态
   * @returns 包含最后更新时间和所有条目的状态对象
   */
  async getStatus(): Promise<HashStatus> {
    if (!this.initialized) await this.initialize();

    return {
      lastUpdated: new Date().toISOString(),
      entries: Array.from(this.hashes.entries()).map(([caveId, hashes]) => ({
        caveId,
        hashes
      }))
    };
  }

  /**
   * 更新指定回声洞的图片哈希值
   * @param caveId 回声洞ID
   * @param imgBuffers 图片buffer数组
   */
  async updateCaveHash(caveId: number, imgBuffers?: Buffer[]): Promise<void> {
    if (!this.initialized) await this.initialize();

    try {
      if (imgBuffers?.length) {
        const hashes = await Promise.all(
          imgBuffers.map(buffer => ImageHasher.calculateHash(buffer))
        );
        this.hashes.set(caveId, hashes);
        logger.info(`Added ${hashes.length} hashes for cave ${caveId}`);
      } else {
        this.hashes.delete(caveId);
        logger.info(`Deleted hashes for cave ${caveId}`);
      }
      await this.saveHashes();
    } catch (error) {
      logger.error(`Failed to update hash (cave ${caveId}): ${error.message}`);
    }
  }

  /**
   * 更新所有回声洞的哈希值
   * @param isInitialBuild 是否为初始构建
   */
  async updateAllCaves(isInitialBuild: boolean = false): Promise<void> {
    if (!this.initialized && !isInitialBuild) {
      await this.initialize();
      return;
    }

    try {
      logger.info('Starting full hash update...');
      const caveData = await this.loadCaveData();
      const cavesWithImages = caveData.filter(cave =>
        cave.elements?.some(el => el.type === 'img' && el.file)
      );

      this.hashes.clear();
      let processedCount = 0;
      const totalImages = cavesWithImages.length;

      const processCave = async (cave: typeof cavesWithImages[0]) => {
        const imgElements = cave.elements?.filter(el => el.type === 'img' && el.file) || [];
        if (imgElements.length === 0) return;

        try {
          const hashes = await Promise.all(
            imgElements.map(async (imgElement) => {
              const filePath = path.join(this.resourceDir, imgElement.file);
              if (!fs.existsSync(filePath)) {
                logger.warn(`Image file not found: ${filePath}`);
                return null;
              }

              const imgBuffer = await readFileAsync(filePath);
              return await ImageHasher.calculateHash(imgBuffer);
            })
          );

          const validHashes = hashes.filter(hash => hash !== null);
          if (validHashes.length > 0) {
            this.hashes.set(cave.cave_id, validHashes);
            processedCount++;

            if (processedCount % 100 === 0) {
              logger.info(`Progress: ${processedCount}/${totalImages}`);
            }
          }
        } catch (error) {
          logger.error(`Failed to process cave ${cave.cave_id}: ${error.message}`);
        }
      };

      await this.processBatch(cavesWithImages, processCave);
      await this.saveHashes();
      logger.success(`Update completed. Processed ${processedCount}/${totalImages} images`);
    } catch (error) {
      logger.error(`Full update failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * 查找重复的图片
   * @param imgBuffers 待查找的图片buffer数组
   * @param threshold 相似度阈值
   * @returns 匹配结果数组，包含索引、回声洞ID和相似度
   */
  async findDuplicates(imgBuffers: Buffer[], threshold: number): Promise<Array<{
    index: number;
    caveId: number;
    similarity: number
  } | null>> {
    // 确保存储已初始化
    if (!this.initialized) await this.initialize();

    // 计算输入图片的哈希值
    const inputHashes = await Promise.all(
      imgBuffers.map(buffer => ImageHasher.calculateHash(buffer))
    );

    // 获取现有的所有哈希值
    const existingHashes = Array.from(this.hashes.entries());

    return Promise.all(
      inputHashes.map(async (hash, index) => {
        try {
          let maxSimilarity = 0;
          let matchedCaveId = null;

          for (const [caveId, hashes] of existingHashes) {
            for (const existingHash of hashes) {
              const similarity = ImageHasher.calculateSimilarity(hash, existingHash);
              if (similarity >= threshold && similarity > maxSimilarity) {
                maxSimilarity = similarity;
                matchedCaveId = caveId;
                if (Math.abs(similarity - 1) < Number.EPSILON) break;
              }
            }
            if (Math.abs(maxSimilarity - 1) < Number.EPSILON) break;
          }

          return matchedCaveId ? {
            index,
            caveId: matchedCaveId,
            similarity: maxSimilarity
          } : null;
        } catch (error) {
          logger.warn(`处理图片 ${index} 失败: ${error.message}`);
          return null;
        }
      })
    );
  }

  /**
   * 加载回声洞数据
   * @returns 回声洞数据数组
   * @private
   */
  private async loadCaveData(): Promise<Array<{
    cave_id: number;
    elements: Array<{ type: string; file?: string }>;
  }>> {
    const data = await FileHandler.readJsonData<Array<{
      cave_id: number;
      elements: Array<{ type: string; file?: string }>;
    }>>(this.caveFilePath);
    return Array.isArray(data) ? data.flat() : [];
  }

  /**
   * 保存哈希数据到文件
   * @private
   */
  private async saveHashes(): Promise<void> {
    const data: HashData = {
      hashes: Object.fromEntries(this.hashes),
      lastUpdated: new Date().toISOString()
    };
    await FileHandler.writeJsonData(this.filePath, [data]);
  }

  /**
   * 构建初始哈希数据
   * @private
   */
  private async buildInitialHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    let processedImageCount = 0;
    // 计算所有图片的总数
    const totalImages = caveData.reduce((sum, cave) =>
      sum + (cave.elements?.filter(el => el.type === 'img' && el.file).length || 0), 0);

    logger.info(`Building hash data for ${totalImages} images...`);

    for (const cave of caveData) {
      const imgElements = cave.elements?.filter(el => el.type === 'img' && el.file) || [];
      if (imgElements.length === 0) continue;

      try {
        const hashes = await Promise.all(
          imgElements.map(async (imgElement) => {
            const filePath = path.join(this.resourceDir, imgElement.file);
            if (!fs.existsSync(filePath)) {
              logger.warn(`Image not found: ${filePath}`);
              return null;
            }
            const imgBuffer = await fs.promises.readFile(filePath);
            const hash = await ImageHasher.calculateHash(imgBuffer);
            processedImageCount++;

            // 每处理100张图片显示一次进度
            if (processedImageCount % 100 === 0) {
              logger.info(`Progress: ${processedImageCount}/${totalImages} images`);
            }

            return hash;
          })
        );

        const validHashes = hashes.filter(hash => hash !== null);
        if (validHashes.length > 0) {
          this.hashes.set(cave.cave_id, validHashes);
        }
      } catch (error) {
        logger.error(`Failed to process cave ${cave.cave_id}: ${error.message}`);
      }
    }

    await this.saveHashes();
    logger.success(`Build completed. Processed ${processedImageCount}/${totalImages} images`);
  }

  /**
   * 更新缺失的哈希值
   * @private
   */
  private async updateMissingHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    let updatedCount = 0;

    for (const cave of caveData) {
      if (this.hashes.has(cave.cave_id)) continue;

      const imgElements = cave.elements?.filter(el => el.type === 'img' && el.file) || [];
      if (imgElements.length === 0) continue;

      try {
        const hashes = await Promise.all(
          imgElements.map(async (imgElement) => {
            const filePath = path.join(this.resourceDir, imgElement.file);
            if (!fs.existsSync(filePath)) {
              return null;
            }
            const imgBuffer = await fs.promises.readFile(filePath);
            return ImageHasher.calculateHash(imgBuffer);
          })
        );

        const validHashes = hashes.filter(hash => hash !== null);
        if (validHashes.length > 0) {
          this.hashes.set(cave.cave_id, validHashes);
          updatedCount++;
        }
      } catch (error) {
        logger.error(`Failed to process cave ${cave.cave_id}: ${error.message}`);
      }
    }
  }

  /**
   * 批量处理数组项
   * @param items 待处理项数组
   * @param processor 处理函数
   * @param batchSize 批处理大小
   * @private
   */
  private async processBatch<T>(
    items: T[],
    processor: (item: T) => Promise<void>,
    batchSize = HashStorage.BATCH_SIZE
  ): Promise<void> {
    // 按批次处理数组项，避免同时处理太多项导致内存问题
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async item => {
          try {
            await processor(item);
          } catch (error) {
            logger.error(`Batch processing error: ${error.message}`);
          }
        })
      );
    }
  }
}
