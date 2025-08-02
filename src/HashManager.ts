import { Context, Logger } from 'koishi';
import { Config, CaveHashObject } from './index';
import sharp from 'sharp';
import { FileManager } from './FileManager';

/**
 * @class HashManager
 * @description 封装了所有与文本和图片哈希生成、相似度比较、以及相关命令的功能。
 */
export class HashManager {

  /**
   * @constructor
   * @param ctx - Koishi 上下文，用于数据库操作。
   * @param config - 插件配置，用于获取相似度阈值。
   * @param logger - 日志记录器实例。
   * @param fileManager - 文件管理器实例，用于处理历史数据。
   */
  constructor(
    private ctx: Context,
    private config: Config,
    private logger: Logger,
    private fileManager: FileManager,
  ) {}

  /**
   * @description 注册与哈希校验相关的子命令。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    cave.subcommand('.hash', '校验回声洞')
      .usage('校验所有回声洞，为历史数据生成哈希。')
      .action(async ({ session }) => {
        const adminChannelId = this.config.adminChannel?.split(':')[1];
        if (session.channelId !== adminChannelId) {
          return '此指令仅限在管理群组中使用';
        }

        await session.send('正在处理，请稍候...');

        try {
          const report = await this.validateAllCaves();
          return report;
        } catch (error) {
          this.logger.error('校验哈希失败:', error);
          return `校验失败: ${error.message}`;
        }
      });
  }

  /**
   * @description 检查数据库中所有回声洞，并为没有哈希记录的历史数据生成哈希。
   * @returns {Promise<string>} 返回一个包含操作结果的报告字符串。
   */
  private async validateAllCaves(): Promise<string> {
    const allCaves = await this.ctx.database.get('cave', { status: 'active' });
    const existingHashes = await this.ctx.database.get('cave_hash', {});
    const existingHashedCaveIds = new Set(existingHashes.map(h => h.cave));

    const hashesToInsert: CaveHashObject[] = [];
    let historicalCount = 0;

    for (const cave of allCaves) {
      if (existingHashedCaveIds.has(cave.id)) continue;

      this.logger.info(`正在为回声洞（${cave.id}）生成哈希...`);
      historicalCount++;

      // 为文本元素生成哈希
      const textElements = cave.elements.filter(el => el.type === 'text' && el.content);
      for (const el of textElements) {
        const textHash = this.generateTextHash(el.content);
        hashesToInsert.push({ cave: cave.id, hash: textHash, type: 'text', subType: 'shingle' });
      }

      // 为图片元素生成哈希
      const imageElements = cave.elements.filter(el => el.type === 'image' && el.file);
      for (const el of imageElements) {
        try {
          const imageBuffer = await this.fileManager.readFile(el.file);

          const pHash = await this.generateImagePHash(imageBuffer);
          hashesToInsert.push({ cave: cave.id, hash: pHash, type: 'image', subType: 'pHash' });

          const subHashes = await this.generateImageSubHashes(imageBuffer);
          subHashes.forEach(subHash => {
            hashesToInsert.push({ cave: cave.id, hash: subHash, type: 'image', subType: 'subImage' });
          });
        } catch (e) {
          this.logger.warn(`无法为回声洞（${cave.id}）的内容（${el.file}）生成哈希:`, e);
        }
      }
    }

    if (hashesToInsert.length > 0) {
      await this.ctx.database.upsert('cave_hash', hashesToInsert);
    } else {
      this.logger.info('无需补全哈希');
    }

    return `校验完成，共补全 ${historicalCount} 个回声洞的 ${hashesToInsert.length} 条哈希`;
  }

  /**
   * @description 将图片切割为4个象限并为每个象限生成pHash。
   * @param imageBuffer - 图片的 Buffer 数据。
   * @returns {Promise<Set<string>>} 返回一个包含最多4个唯一哈希值的集合。
   */
  public async generateImageSubHashes(imageBuffer: Buffer): Promise<Set<string>> {
    const hashes = new Set<string>();
    try {
        const metadata = await sharp(imageBuffer).metadata();
        const { width, height } = metadata;

        if (!width || !height || width < 16 || height < 16) {
            return hashes;
        }

        const regions = [
            { left: 0, top: 0, width: Math.floor(width / 2), height: Math.floor(height / 2) }, // Top-left
            { left: Math.floor(width / 2), top: 0, width: Math.ceil(width / 2), height: Math.floor(height / 2) }, // Top-right
            { left: 0, top: Math.floor(height / 2), width: Math.floor(width / 2), height: Math.ceil(height / 2) }, // Bottom-left
            { left: Math.floor(width / 2), top: Math.floor(height / 2), width: Math.ceil(width / 2), height: Math.ceil(height / 2) }, // Bottom-right
        ];

        for (const region of regions) {
            if (region.width < 8 || region.height < 8) continue;
            const quadrantBuffer = await sharp(imageBuffer).extract(region).toBuffer();
            const subHash = await this.generateImagePHash(quadrantBuffer);
            hashes.add(subHash);
        }
    } catch (e) {
        this.logger.warn(`生成子哈希失败:`, e);
    }
    return hashes;
  }

  /**
   * @description 根据pHash（感知哈希）算法为图片生成哈希值。
   * @param imageBuffer - 图片的 Buffer 数据。
   * @returns {Promise<string>} 返回一个64位的二进制哈希字符串。
   */
  public async generateImagePHash(imageBuffer: Buffer): Promise<string> {
    const smallImage = await sharp(imageBuffer)
      .grayscale()
      .resize(8, 8, { fit: 'fill' })
      .raw()
      .toBuffer();

    let totalLuminance = 0;
    for (let i = 0; i < 64; i++) {
      totalLuminance += smallImage[i];
    }
    const avgLuminance = totalLuminance / 64;

    let hash = '';
    for (let i = 0; i < 64; i++) {
      hash += smallImage[i] > avgLuminance ? '1' : '0';
    }
    return hash;
  }

  /**
   * @description 计算两个哈希字符串之间的汉明距离（不同字符的数量）。
   * @param hash1 - 第一个哈希字符串。
   * @param hash2 - 第二个哈希字符串。
   * @returns {number} 两个哈希之间的距离。
   */
  public calculateHammingDistance(hash1: string, hash2: string): number {
    let distance = 0;
    for (let i = 0; i < Math.min(hash1.length, hash2.length); i++) {
      if (hash1[i] !== hash2[i]) {
        distance++;
      }
    }
    return distance;
  }

  /**
   * @description 根据汉明距离计算图片pHash的相似度。
   * @param hash1 - 第一个哈希字符串。
   * @param hash2 - 第二个哈希字符串。
   * @returns {number} 范围在0到1之间的相似度得分。
   */
  public calculateImageSimilarity(hash1: string, hash2: string): number {
    const distance = this.calculateHammingDistance(hash1, hash2);
    // 假设哈希长度为64位
    const hashLength = 64;
    return 1 - (distance / hashLength);
  }

  /**
   * @description 将文本分割成指定大小的“瓦片”(shingles)，用于Jaccard相似度计算。
   * @param text - 输入的文本。
   * @param size - 每个瓦片的大小，默认为2。
   * @returns {Set<string>} 包含所有唯一瓦片的集合。
   */
  private getShingles(text: string, size = 2): Set<string> {
    const shingles = new Set<string>();
    const cleanedText = text.replace(/\s+/g, '');
    for (let i = 0; i <= cleanedText.length - size; i++) {
      shingles.add(cleanedText.substring(i, i + size));
    }
    return shingles;
  }

  /**
   * @description 为文本生成基于Shingling的哈希字符串。
   * @param text - 需要处理的文本。
   * @returns {string} 由排序后的shingles组成的、用'|'分隔的哈希字符串。
   */
  public generateTextHash(text: string): string {
    if (!text) return '';
    const shingles = Array.from(this.getShingles(text));
    return shingles.sort().join('|');
  }

  /**
   * @description 使用Jaccard相似度系数计算两个文本哈希的相似度。
   * @param hash1 - 第一个文本哈希。
   * @param hash2 - 第二个文本哈希。
   * @returns {number} 范围在0到1之间的相似度得分。
   */
  public calculateTextSimilarity(hash1: string, hash2: string): number {
    if (!hash1 || !hash2) return 0;
    const set1 = new Set(hash1.split('|'));
    const set2 = new Set(hash2.split('|'));
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return union.size === 0 ? 1 : intersection.size / union.size;
  }
}
