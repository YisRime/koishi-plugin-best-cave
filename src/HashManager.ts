import { Context, Logger } from 'koishi';
import { Config, CaveHashObject } from './index';
import sharp from 'sharp';
import { FileManager } from './FileManager';
import * as crypto from 'crypto';

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
  ) {
    this.ctx.model.extend('cave_hash', {
      cave: 'unsigned',
      hash: 'string',
      type: 'string',
    }, {
      primary: ['cave', 'hash', 'type'],
    });
  }

  /**
   * @description 注册与哈希校验相关的子命令。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    cave.subcommand('.hash', '校验回声洞')
      .usage('校验所有回声洞，为历史数据生成哈希，并检查现有内容的相似度。')
      .action(async ({ session }) => {
        const adminChannelId = this.config.adminChannel?.split(':')[1];
        if (session.channelId !== adminChannelId) {
          return '此指令仅限在管理群组中使用';
        }
        await session.send('正在处理，请稍候...');
        try {
          return await this.validateAllCaves();
        } catch (error) {
          this.logger.error('校验哈希失败:', error);
          return `校验失败: ${error.message}`;
        }
      });
  }

  /**
   * @description 检查数据库中所有回声洞，为没有哈希记录的历史数据生成哈希，并在此之后对所有内容进行相似度检查。
   * @returns {Promise<string>} 一个包含操作结果的报告字符串。
   */
  public async validateAllCaves(): Promise<string> {
    const allCaves = await this.ctx.database.get('cave', { status: 'active' });
    const existingHashedCaveIds = new Set((await this.ctx.database.get('cave_hash', {}, { fields: ['cave'] })).map(h => h.cave));

    let hashesToInsert: CaveHashObject[] = [];
    let historicalCount = 0;
    let totalHashesGenerated = 0;
    let batchStartCaveCount = 0;

    const flushHashes = async () => {
      if (hashesToInsert.length > 0) {
        this.logger.info(`补全第 ${batchStartCaveCount + 1} 到 ${historicalCount} 条回声洞哈希中...`);
        try {
          await this.ctx.database.upsert('cave_hash', hashesToInsert);
          totalHashesGenerated += hashesToInsert.length;
        } catch (error) {
          this.logger.error(`导入哈希失败: ${error.message}`);
        }
        hashesToInsert = [];
        batchStartCaveCount = historicalCount;
      }
    };

    for (const cave of allCaves) {
      if (existingHashedCaveIds.has(cave.id)) continue;

      historicalCount++;

      const newHashesForCave: CaveHashObject[] = [];

      const combinedText = cave.elements.filter(el => el.type === 'text' && el.content).map(el => el.content).join(' ');
      const textHash = this.generateTextSimhash(combinedText);
      if (textHash) {
        newHashesForCave.push({ cave: cave.id, hash: textHash, type: 'sim' });
      }

      for (const el of cave.elements.filter(el => el.type === 'image' && el.file)) {
        try {
          const imageBuffer = await this.fileManager.readFile(el.file);
          const pHash = await this.generateImagePHash(imageBuffer);
          newHashesForCave.push({ cave: cave.id, hash: pHash, type: 'phash' });
          const subHashes = await this.generateImageSubHashes(imageBuffer);
          subHashes.forEach(subHash => newHashesForCave.push({ cave: cave.id, hash: subHash, type: 'sub' }));
        } catch (e) {
          this.logger.warn(`无法为回声洞（${cave.id}）的内容（${el.file}）生成哈希:`, e);
        }
      }

      const uniqueHashesMap = new Map<string, CaveHashObject>();
      newHashesForCave.forEach(h => {
        const uniqueKey = `${h.type}-${h.hash}`;
        uniqueHashesMap.set(uniqueKey, h);
      });
      hashesToInsert.push(...uniqueHashesMap.values());

      if (hashesToInsert.length >= 100) await flushHashes();
    }
    await flushHashes();

    const generationReport = totalHashesGenerated > 0
      ? `已补全 ${historicalCount} 个回声洞的 ${totalHashesGenerated} 条哈希\n`
      : '无需补全回声洞的哈希\n';

    const allHashes = await this.ctx.database.get('cave_hash', {});
    const caveTextHashes = new Map<number, string>();
    const caveImagePHashes = new Map<number, string[]>();

    for (const hash of allHashes) {
      if (hash.type === 'sim') {
        caveTextHashes.set(hash.cave, hash.hash);
      } else if (hash.type === 'phash') {
        if (!caveImagePHashes.has(hash.cave)) caveImagePHashes.set(hash.cave, []);
        caveImagePHashes.get(hash.cave)!.push(hash.hash);
      }
    }

    const caveIds = allCaves.map(c => c.id);
    const similarPairs = new Set<string>();

    for (let i = 0; i < caveIds.length; i++) {
      for (let j = i + 1; j < caveIds.length; j++) {
        const id1 = caveIds[i];
        const id2 = caveIds[j];

        const textHash1 = caveTextHashes.get(id1);
        const textHash2 = caveTextHashes.get(id2);
        if (textHash1 && textHash2) {
          const textSim = this.calculateSimilarity(textHash1, textHash2);
          if (textSim >= this.config.textThreshold) {
            similarPairs.add(`文本:（${id1}，${id2}），相似度：${(textSim * 100).toFixed(2)}%`);
          }
        }

        const imageHashes1 = caveImagePHashes.get(id1) || [];
        const imageHashes2 = caveImagePHashes.get(id2) || [];
        if (imageHashes1.length > 0 && imageHashes2.length > 0) {
          for (const imgHash1 of imageHashes1) {
            for (const imgHash2 of imageHashes2) {
              const imgSim = this.calculateSimilarity(imgHash1, imgHash2);
              if (imgSim >= this.config.imageThreshold) {
                similarPairs.add(`图片:（${id1}，${id2}），相似度：${(imgSim * 100).toFixed(2)}%`);
              }
            }
          }
        }
      }
    }

    const similarityReport = similarPairs.size > 0
      ? `发现 ${similarPairs.size} 对高相似度内容:\n` + [...similarPairs].join('\n')
      : '未发现高相似度内容';

    return `校验完成:\n${generationReport}${similarityReport}`;
  }

  /**
   * @description 将图片切割为4个象限并为每个象限生成pHash。
   * @param imageBuffer - 图片的 Buffer 数据。
   * @returns {Promise<Set<string>>} 一个包含最多4个唯一哈希值的集合。
   */
  public async generateImageSubHashes(imageBuffer: Buffer): Promise<Set<string>> {
    const hashes = new Set<string>();
    try {
      const metadata = await sharp(imageBuffer).metadata();
      const { width, height } = metadata;
      if (!width || !height || width < 16 || height < 16) return hashes;

      const regions = [
        { left: 0, top: 0, width: Math.floor(width / 2), height: Math.floor(height / 2) },
        { left: Math.floor(width / 2), top: 0, width: Math.ceil(width / 2), height: Math.floor(height / 2) },
        { left: 0, top: Math.floor(height / 2), width: Math.floor(width / 2), height: Math.ceil(height / 2) },
        { left: Math.floor(width / 2), top: Math.floor(height / 2), width: Math.ceil(width / 2), height: Math.ceil(height / 2) },
      ];

      for (const region of regions) {
        if (region.width < 8 || region.height < 8) continue;
        const quadrantBuffer = await sharp(imageBuffer).extract(region).toBuffer();
        hashes.add(await this.generateImagePHash(quadrantBuffer));
      }
    } catch (e) {
      this.logger.warn(`生成子哈希失败:`, e);
    }
    return hashes;
  }

  /**
   * @description 根据感知哈希（pHash）算法为图片生成哈希。
   * @param imageBuffer 图片的 Buffer 数据。
   * @returns 64位二进制哈希字符串。
   */
  public async generateImagePHash(imageBuffer: Buffer): Promise<string> {
    const smallImage = await sharp(imageBuffer).grayscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer();
    const totalLuminance = smallImage.reduce((acc, val) => acc + val, 0);
    const avgLuminance = totalLuminance / 64;
    return Array.from(smallImage).map(lum => lum > avgLuminance ? '1' : '0').join('');
  }

  /**
   * @description 计算两个哈希字符串之间的汉明距离（不同字符的数量）。
   * @param hash1 - 第一个哈希字符串。
   * @param hash2 - 第二个哈希字符串。
   * @returns {number} 两个哈希之间的距离。
   */
  public calculateHammingDistance(hash1: string, hash2: string): number {
    let distance = 0;
    const len = Math.min(hash1.length, hash2.length);
    for (let i = 0; i < len; i++) {
      if (hash1[i] !== hash2[i]) distance++;
    }
    return distance;
  }

  /**
   * @description 根据汉明距离计算图片或文本哈希的相似度。
   * @param hash1 - 第一个哈希字符串。
   * @param hash2 - 第二个哈希字符串。
   * @returns {number} 范围在0到1之间的相似度得分。
   */
  public calculateSimilarity(hash1: string, hash2: string): number {
    const distance = this.calculateHammingDistance(hash1, hash2);
    const hashLength = Math.max(hash1.length, hash2.length);
    return hashLength === 0 ? 1 : 1 - (distance / hashLength);
  }

  /**
   * @description 为文本生成基于 Simhash 算法的哈希字符串。
   * @param text - 需要处理的文本。
   * @returns {string} 64位二进制 Simhash 字符串。
   */
  public generateTextSimhash(text: string): string {
    if (!text?.trim()) return '';
    const tokens = text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
    if (tokens.length === 0) return '';

    const vector = new Array(64).fill(0);
    tokens.forEach(token => {
      const hash = crypto.createHash('md5').update(token).digest();
      for (let i = 0; i < 64; i++) {
        vector[i] += (hash[Math.floor(i / 8)] >> (i % 8)) & 1 ? 1 : -1;
      }
    });

    return vector.map(v => v > 0 ? '1' : '0').join('');
  }
}
