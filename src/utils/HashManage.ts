import { Logger } from 'koishi';
import * as fs from 'fs';
import * as path from 'path';
import { ContentHasher } from './ContentHash';
import { FileHandler } from './FileHandle';
import { promisify } from 'util';

const logger = new Logger('HashManager');
const readFileAsync = promisify(fs.readFile);

/**
 * 内容哈希存储类型
 */
interface ContentHashData {
  imageHashes: Record<string, string[]>;
  textHashes: Record<string, string[]>;
  lastUpdated?: string;
}

/**
 * 哈希存储状态类型
 */
interface HashStorageStatus {
  lastUpdated: string;
  entries: Array<{
    caveId: number;
    imageHashes: string[];
    textHashes: string[];
  }>;
}

/**
 * 图片哈希值存储管理类
 * 负责管理和维护回声洞图片的哈希值
 */
export class ContentHashManager {
  // 哈希数据文件名
  private static readonly HASH_FILE = 'hash.json';
  // 回声洞数据文件名
  private static readonly CAVE_FILE = 'cave.json';
  // 批处理大小
  private static readonly BATCH_SIZE = 50;
  // 存储回声洞ID到图片哈希值的映射
  private imageHashes = new Map<number, string[]>();
  private textHashes = new Map<number, string[]>();
  // 初始化状态标志
  private initialized = false;

  /**
   * 初始化HashManager实例
   * @param caveDir 回声洞数据目录路径
   */
  constructor(private readonly caveDir: string) {}

  private get filePath() {
    return path.join(this.caveDir, ContentHashManager.HASH_FILE);
  }

  private get resourceDir() {
    return path.join(this.caveDir, 'resources');
  }

  private get caveFilePath() {
    return path.join(this.caveDir, ContentHashManager.CAVE_FILE);
  }

  /**
   * 初始化哈希存储
   * 读取现有哈希数据或重新构建哈希值
   * @throws 初始化失败时抛出错误
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const hashData = await FileHandler.readJsonData<ContentHashData>(this.filePath)
        .then(data => data[0])
        .catch(() => null);

      if (!hashData?.imageHashes || !hashData?.textHashes ||
          Object.keys(hashData.imageHashes).length === 0) {
        this.imageHashes.clear();
        this.textHashes.clear();
        await this.buildInitialHashes();
      } else {
        this.imageHashes = new Map(
          Object.entries(hashData.imageHashes).map(([k, v]) => [Number(k), v as string[]])
        );
        this.textHashes = new Map(
          Object.entries(hashData.textHashes).map(([k, v]) => [Number(k), v as string[]])
        );
        await this.updateMissingHashes();
      }

      const totalCaves = new Set([...this.imageHashes.keys(), ...this.textHashes.keys()]).size;
      this.initialized = true;
      logger.success(`Cave Hash Manager initialized with ${totalCaves} hashes`);
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
  async getStatus(): Promise<HashStorageStatus> {
    if (!this.initialized) await this.initialize();

    return {
      lastUpdated: new Date().toISOString(),
      entries: Array.from(this.imageHashes.entries()).map(([caveId, imgHashes]) => ({
        caveId,
        imageHashes: imgHashes,
        textHashes: this.textHashes.get(caveId) || []
      }))
    };
  }

  /**
   * 更新指定回声洞的图片哈希值
   * @param caveId 回声洞ID
   * @param content 图片buffer数组
   */
  async updateCaveContent(caveId: number, content: {
    images?: Buffer[],
    texts?: string[]
  }): Promise<void> {
    if (!this.initialized) await this.initialize();

    try {
      if (content.images?.length) {
        const imageHashes = await Promise.all(
          content.images.map(buffer => ContentHasher.calculateHash(buffer))
        );
        this.imageHashes.set(caveId, imageHashes);
      }

      if (content.texts?.length) {
        const textHashes = content.texts.map(text => ContentHasher.calculateTextHash(text));
        this.textHashes.set(caveId, textHashes);
      }

      if (!content.images && !content.texts) {
        this.imageHashes.delete(caveId);
        this.textHashes.delete(caveId);
      }

      await this.saveContentHashes();
    } catch (error) {
      logger.error(`Failed to update content hashes (cave ${caveId}): ${error.message}`);
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

      this.imageHashes.clear();
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
              return await ContentHasher.calculateHash(imgBuffer);
            })
          );

          const validHashes = hashes.filter(hash => hash !== null);
          if (validHashes.length > 0) {
            this.imageHashes.set(cave.cave_id, validHashes);
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
      await this.saveContentHashes();
      logger.success(`Update completed. Processed ${processedCount}/${totalImages} images`);
    } catch (error) {
      logger.error(`Full update failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * 查找重复的图片
   * @param content 待查找的图片buffer数组
   * @param thresholds 相似度阈值
   * @returns 匹配结果数组，包含索引、回声洞ID和相似度
   */
  async findDuplicates(content: {
    images?: Buffer[],
    texts?: string[]
  }, thresholds: {
    image: number,
    text: number
  }): Promise<Array<{
    type: 'image' | 'text';
    index: number;
    caveId: number;
    similarity: number;
  } | null>> {
    if (!this.initialized) await this.initialize();

    const results: Array<{
      type: 'image' | 'text';
      index: number;
      caveId: number;
      similarity: number;
    } | null> = [];

    // 处理图片查重
    if (content.images?.length) {
      const imageResults = await this.findImageDuplicates(content.images, thresholds.image);
      results.push(...imageResults.map(result =>
        result ? { ...result, type: 'image' as const } : null
      ));
    }

    // 处理文本查重
    if (content.texts?.length) {
      const textResults = await this.findTextDuplicates(content.texts, thresholds.text);
      results.push(...textResults.map(result =>
        result ? { ...result, type: 'text' as const } : null
      ));
    }

    return results;
  }

  private async findTextDuplicates(texts: string[], threshold: number): Promise<Array<{
    index: number;
    caveId: number;
    similarity: number;
  } | null>> {
    const inputHashes = texts.map(text => ContentHasher.calculateTextHash(text));
    const existingHashes = Array.from(this.textHashes.entries());

    return inputHashes.map((hash, index) => {
      let maxSimilarity = 0;
      let matchedCaveId = null;

      for (const [caveId, hashes] of existingHashes) {
        for (const existingHash of hashes) {
          const similarity = this.calculateTextSimilarity(hash, existingHash);
          if (similarity >= threshold && similarity > maxSimilarity) {
            maxSimilarity = similarity;
            matchedCaveId = caveId;
            if (similarity === 1) break;
          }
        }
        if (maxSimilarity === 1) break;
      }

      return matchedCaveId ? {
        index,
        caveId: matchedCaveId,
        similarity: maxSimilarity
      } : null;
    });
  }

  private calculateTextSimilarity(hash1: string, hash2: string): number {
    if (hash1 === hash2) return 1;
    // 实现一个简单的文本相似度算法
    // 这里可以根据需要使用更复杂的算法
    const length = Math.max(hash1.length, hash2.length);
    let matches = 0;
    for (let i = 0; i < length; i++) {
      if (hash1[i] === hash2[i]) matches++;
    }
    return matches / length;
  }

  // 重命名原有的图片哈希相关方法
  private async findImageDuplicates(images: Buffer[], threshold: number): Promise<Array<{
    index: number;
    caveId: number;
    similarity: number;
  } | null>> {
    // 确保存储已初始化
    if (!this.initialized) await this.initialize();

    // 计算输入图片的哈希值
    const inputHashes = await Promise.all(
      images.map(buffer => ContentHasher.calculateHash(buffer))
    );

    // 获取现有的所有哈希值
    const existingHashes = Array.from(this.imageHashes.entries());

    return Promise.all(
      inputHashes.map(async (hash, index) => {
        try {
          let maxSimilarity = 0;
          let matchedCaveId = null;

          for (const [caveId, hashes] of existingHashes) {
            for (const existingHash of hashes) {
              const similarity = ContentHasher.calculateSimilarity(hash, existingHash);
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
  private async saveContentHashes(): Promise<void> {
    const data: ContentHashData = {
      imageHashes: Object.fromEntries(this.imageHashes),
      textHashes: Object.fromEntries(this.textHashes),
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
    let processedCount = 0;
    const totalCaves = caveData.length;

    logger.info(`Building hash data for ${totalCaves} caves...`);

    for (const cave of caveData) {
      try {
        // 处理图片哈希
        const imgElements = cave.elements?.filter(el => el.type === 'img' && el.file) || [];
        if (imgElements.length > 0) {
          const hashes = await Promise.all(
            imgElements.map(async (imgElement) => {
              const filePath = path.join(this.resourceDir, imgElement.file);
              if (!fs.existsSync(filePath)) {
                logger.warn(`Image not found: ${filePath}`);
                return null;
              }
              const imgBuffer = await fs.promises.readFile(filePath);
              return await ContentHasher.calculateHash(imgBuffer);
            })
          );

          const validHashes = hashes.filter(hash => hash !== null);
          if (validHashes.length > 0) {
            this.imageHashes.set(cave.cave_id, validHashes);
          }
        }

        // 处理文本哈希
        const textElements = cave.elements?.filter(el => el.type === 'text' && (el as any).content) || [];
        if (textElements.length > 0) {
          const textHashes = textElements.map(el => ContentHasher.calculateTextHash((el as any).content));
          this.textHashes.set(cave.cave_id, textHashes);
        }

        processedCount++;
        if (processedCount % 100 === 0) {
          logger.info(`Progress: ${processedCount}/${totalCaves} caves`);
        }
      } catch (error) {
        logger.error(`Failed to process cave ${cave.cave_id}: ${error.message}`);
      }
    }

    await this.saveContentHashes();
    logger.success(`Build completed. Processed ${processedCount}/${totalCaves} caves`);
  }

  /**
   * 更新缺失的哈希值
   * @private
   */
  private async updateMissingHashes(): Promise<void> {
    const caveData = await this.loadCaveData();
    let updatedCount = 0;

    for (const cave of caveData) {
      if (this.imageHashes.has(cave.cave_id)) continue;

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
            return ContentHasher.calculateHash(imgBuffer);
          })
        );

        const validHashes = hashes.filter(hash => hash !== null);
        if (validHashes.length > 0) {
          this.imageHashes.set(cave.cave_id, validHashes);
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
    batchSize = ContentHashManager.BATCH_SIZE
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
