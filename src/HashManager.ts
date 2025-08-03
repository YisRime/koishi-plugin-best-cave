import { Context, Logger } from 'koishi';
import { Config, CaveObject } from './index';
import sharp from 'sharp';
import { FileManager } from './FileManager';
import * as crypto from 'crypto';

/**
 * @description 数据库 `cave_hash` 表的完整对象模型。
 */
export interface CaveHashObject {
  cave: number;
  hash: string;
  type: 'simhash' | 'phash_color' | 'dhash_gray' | 'sub_phash_q1' | 'sub_phash_q2' | 'sub_phash_q3' | 'sub_phash_q4';
}

/**
 * @class HashManager
 * @description 封装了所有与文本和图片哈希生成、相似度比较、以及相关命令的功能。
 * 实现了高精度的混合策略查重方案。
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
    const adminCheck = ({ session }) => {
      const adminChannelId = this.config.adminChannel?.split(':')[1];
      if (session.channelId !== adminChannelId) {
        return '此指令仅限在管理群组中使用';
      }
    };

    cave.subcommand('.hash', '校验回声洞')
      .usage('校验所有回声洞，补全所有哈希记录。')
      .action(async (argv) => {
        const checkResult = adminCheck(argv);
        if (checkResult) return checkResult;

        await argv.session.send('正在处理，请稍候...');
        try {
          return await this.generateHashesForHistoricalCaves();
        } catch (error) {
          this.logger.error('生成历史哈希失败:', error);
          return `操作失败: ${error.message}`;
        }
      });

    cave.subcommand('.check', '检查回声洞')
      .usage('检查所有已存在哈希的回声洞的相似度。')
      .action(async (argv) => {
        const checkResult = adminCheck(argv);
        if (checkResult) return checkResult;

        await argv.session.send('正在检查，请稍候...');
        try {
          return await this.checkForSimilarCaves();
        } catch (error) {
          this.logger.error('检查相似度失败:', error);
          return `检查失败: ${error.message}`;
        }
      });
  }

  /**
   * @description 检查数据库中所有回声洞，为没有哈希记录的历史数据生成哈希。
   * @returns {Promise<string>} 一个包含操作结果的报告字符串。
   */
  public async generateHashesForHistoricalCaves(): Promise<string> {
    const allCaves = await this.ctx.database.get('cave', { status: 'active' });
    const existingHashes = await this.ctx.database.get('cave_hash', {}, { fields: ['cave', 'hash', 'type'] });
    const existingHashSet = new Set(existingHashes.map(h => `${h.cave}-${h.hash}-${h.type}`));
    const processedCaveIds = new Set(existingHashes.map(h => h.cave));

    const cavesToProcess = allCaves.filter(cave => !processedCaveIds.has(cave.id));
    const totalToProcessCount = cavesToProcess.length;

    if (totalToProcessCount === 0) {
      return '无需补全回声洞哈希';
    }

    this.logger.info(`开始补全 ${totalToProcessCount} 个回声洞的哈希...`);

    let hashesToInsert: CaveHashObject[] = [];
    const batchHashSet = new Set<string>();
    let processedCaveCount = 0;
    let totalHashesGenerated = 0;
    let errorCount = 0;

    const flushBatch = async () => {
      const batchSize = hashesToInsert.length;
      if (batchSize === 0) return;

      await this.ctx.database.upsert('cave_hash', hashesToInsert);
      totalHashesGenerated += batchSize;
      this.logger.info(`正在导入 ${batchSize} 条回声洞哈希... (已处理 ${processedCaveCount}/${totalToProcessCount})`);

      hashesToInsert = [];
      batchHashSet.clear();
    };

    for (const cave of cavesToProcess) {
      processedCaveCount++;

      try {
        const newHashesForCave = await this.generateAllHashesForCave(cave);
        for (const hashObj of newHashesForCave) {
          const uniqueKey = `${hashObj.cave}-${hashObj.hash}-${hashObj.type}`;
          if (!existingHashSet.has(uniqueKey) && !batchHashSet.has(uniqueKey)) {
            hashesToInsert.push(hashObj);
            batchHashSet.add(uniqueKey);
          }
        }
      } catch (error) {
        errorCount++;
        this.logger.warn(`补全回声洞（${cave.id}）时发生错误: ${error.message}`);
        continue;
      }

      if (hashesToInsert.length >= 100) {
        await flushBatch();
      }
    }

    await flushBatch();

    return `已补全 ${totalToProcessCount} 个回声洞的 ${totalHashesGenerated} 条哈希（失败${errorCount} 条）`;
  }

  /**
   * @description 为单个回声洞对象生成所有类型的哈希。
   * @param cave - 回声洞对象。
   * @returns {Promise<CaveHashObject[]>} 生成的哈希对象数组。
   */
  public async generateAllHashesForCave(cave: Pick<CaveObject, 'id' | 'elements'>): Promise<CaveHashObject[]> {
    const allHashes: CaveHashObject[] = [];

    const combinedText = cave.elements.filter(el => el.type === 'text' && el.content).map(el => el.content).join(' ');
    if (combinedText) {
        const textHash = this.generateTextSimhash(combinedText);
        if (textHash) {
            allHashes.push({ cave: cave.id, hash: textHash, type: 'simhash' });
        }
    }

    for (const el of cave.elements.filter(el => el.type === 'image' && el.file)) {
        try {
            const imageBuffer = await this.fileManager.readFile(el.file);
            const imageHashes = await this.generateAllImageHashes(imageBuffer);

            allHashes.push({ cave: cave.id, hash: imageHashes.colorPHash, type: 'phash_color' });
            allHashes.push({ cave: cave.id, hash: imageHashes.dHash, type: 'dhash_gray' });
            allHashes.push({ cave: cave.id, hash: imageHashes.subHashes.q1, type: 'sub_phash_q1' });
            allHashes.push({ cave: cave.id, hash: imageHashes.subHashes.q2, type: 'sub_phash_q2' });
            allHashes.push({ cave: cave.id, hash: imageHashes.subHashes.q3, type: 'sub_phash_q3' });
            allHashes.push({ cave: cave.id, hash: imageHashes.subHashes.q4, type: 'sub_phash_q4' });
        } catch (e) {
            this.logger.warn(`无法为回声洞（${cave.id}）的内容（${el.file}）生成哈希:`, e);
        }
    }
    return allHashes;
  }

  /**
   * @description 为单个图片Buffer生成所有类型的哈希。
   * @param imageBuffer - 图片的Buffer数据。
   * @returns {Promise<object>} 包含所有图片哈希的对象。
   */
  public async generateAllImageHashes(imageBuffer: Buffer) {
    const [colorPHash, dHash, subHashes] = await Promise.all([
        this.generateColorPHash(imageBuffer),
        this.generateDHash(imageBuffer),
        this.generateImageSubHashes(imageBuffer)
    ]);
    return { colorPHash, dHash, subHashes };
  }


  /**
   * @description 对回声洞进行混合策略的相似度与重复内容检查。
   * @returns {Promise<string>} 一个包含操作结果的报告字符串。
   */
  public async checkForSimilarCaves(): Promise<string> {
    const allHashes = await this.ctx.database.get('cave_hash', {});
    const caves = await this.ctx.database.get('cave', { status: 'active' }, { fields: ['id'] });
    const allCaveIds = caves.map(c => c.id);

    const hashGroups: Record<string, Map<number, string[]>> = {
        simhash: new Map(),
        phash_color: new Map(),
        dhash_gray: new Map(),
    };
    const subHashToCaves = new Map<string, Set<number>>();

    for (const hash of allHashes) {
        if (hashGroups[hash.type]) {
            if (!hashGroups[hash.type].has(hash.cave)) hashGroups[hash.type].set(hash.cave, []);
            hashGroups[hash.type].get(hash.cave)!.push(hash.hash);
        } else if (hash.type.startsWith('sub_phash_')) {
            if (!subHashToCaves.has(hash.hash)) subHashToCaves.set(hash.hash, new Set());
            subHashToCaves.get(hash.hash)!.add(hash.cave);
        }
    }

    const similarPairs = {
        text: new Set<string>(),
        image_color: new Set<string>(),
        image_dhash: new Set<string>(),
    };

    for (let i = 0; i < allCaveIds.length; i++) {
        for (let j = i + 1; j < allCaveIds.length; j++) {
            const id1 = allCaveIds[i];
            const id2 = allCaveIds[j];

            // 文本相似度
            const simhash1 = hashGroups.simhash.get(id1)?.[0];
            const simhash2 = hashGroups.simhash.get(id2)?.[0];
            if (simhash1 && simhash2) {
                const sim = this.calculateSimilarity(simhash1, simhash2);
                if (sim >= this.config.textThreshold) {
                    similarPairs.text.add(`${id1} & ${id2} = ${(sim * 100).toFixed(2)}%`);
                }
            }

            // 颜色pHash相似度
            const colorHashes1 = hashGroups.phash_color.get(id1) || [];
            const colorHashes2 = hashGroups.phash_color.get(id2) || [];
            for (const h1 of colorHashes1) {
                for (const h2 of colorHashes2) {
                    const sim = this.calculateSimilarity(h1, h2);
                    if (sim >= this.config.imageThreshold) {
                        similarPairs.image_color.add(`${id1} & ${id2} = ${(sim * 100).toFixed(2)}%`);
                    }
                }
            }

            // dHash相似度
            const dHashes1 = hashGroups.dhash_gray.get(id1) || [];
            const dHashes2 = hashGroups.dhash_gray.get(id2) || [];
            for (const h1 of dHashes1) {
                for (const h2 of dHashes2) {
                    const sim = this.calculateSimilarity(h1, h2);
                    if (sim >= this.config.imageThreshold) {
                        similarPairs.image_dhash.add(`${id1} & ${id2} = ${(sim * 100).toFixed(2)}%`);
                    }
                }
            }
        }
    }

    const subHashDuplicates: string[] = [];
    subHashToCaves.forEach((caves) => {
      if (caves.size > 1) {
        const sortedCaves = [...caves].sort((a, b) => a - b).join(', ');
        subHashDuplicates.push(`[${sortedCaves}]`);
      }
    });

    const totalFindings = similarPairs.text.size + similarPairs.image_color.size + similarPairs.image_dhash.size + subHashDuplicates.length;
    if (totalFindings === 0) return '未发现高相似度的内容';

    let report = `已发现 ${totalFindings} 组高相似度或重复的内容:`;
    if (similarPairs.text.size > 0) report += '\n文本近似:\n' + [...similarPairs.text].join('\n');
    if (similarPairs.image_color.size > 0) report += '\n图片整体相似:\n' + [...similarPairs.image_color].join('\n');
    if (similarPairs.image_dhash.size > 0) report += '\n图片结构相似:\n' + [...similarPairs.image_dhash].join('\n');
    if (subHashDuplicates.length > 0) report += '\n图片局部重复:\n' + [...new Set(subHashDuplicates)].join('\n');

    return report.trim();
  }

  /**
   * @description 从单通道原始像素数据计算pHash。
   * @param channelData - 单通道的像素值数组。
   * @param size - 图像的边长（例如16）。
   * @returns {string} 该通道的二进制哈希字符串。
   */
  private _calculateHashFromRawChannel(channelData: number[], size: number): string {
    const totalLuminance = channelData.reduce((acc, val) => acc + val, 0);
    const avgLuminance = totalLuminance / (size * size);
    return channelData.map(lum => lum > avgLuminance ? '1' : '0').join('');
  }

  /**
   * @description 生成768位颜色感知哈希（Color pHash）。
   * @param imageBuffer - 图片的 Buffer 数据。
   * @returns {Promise<string>} 768位二进制哈希对应的192位十六进制字符串。
   */
  public async generateColorPHash(imageBuffer: Buffer): Promise<string> {
    const { data, info } = await sharp(imageBuffer).resize(16, 16, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { channels } = info;
    const r: number[] = [], g: number[] = [], b: number[] = [];

    for (let i = 0; i < data.length; i += channels) {
        r.push(data[i]);
        g.push(data[i + 1]);
        b.push(data[i + 2]);
    }

    const rHash = this._calculateHashFromRawChannel(r, 16);
    const gHash = this._calculateHashFromRawChannel(g, 16);
    const bHash = this._calculateHashFromRawChannel(b, 16);

    const combinedHash = rHash + gHash + bHash; // 768 bits
    let hex = '';
    for (let i = 0; i < combinedHash.length; i += 4) {
        hex += parseInt(combinedHash.substring(i, i + 4), 2).toString(16);
    }
    return hex.padStart(192, '0');
  }

  /**
   * @description 生成256位差异哈希（dHash）。
   * @param imageBuffer - 图片的 Buffer 数据。
   * @returns {Promise<string>} 256位二进制哈希对应的64位十六进制字符串。
   */
  public async generateDHash(imageBuffer: Buffer): Promise<string> {
    const pixels = await sharp(imageBuffer).grayscale().resize(17, 16, { fit: 'fill' }).raw().toBuffer();
    let hash = '';
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            const i = y * 17 + x;
            hash += pixels[i]! > pixels[i + 1]! ? '1' : '0';
        }
    }
    return BigInt('0b' + hash).toString(16).padStart(64, '0');
  }

  /**
   * @description 将图片切割为4个象限并为每个象限生成Color pHash。
   * @param imageBuffer - 图片的 Buffer 数据。
   * @returns {Promise<object>} 包含四个象限哈希的对象。
   */
  public async generateImageSubHashes(imageBuffer: Buffer): Promise<{ q1: string, q2: string, q3: string, q4: string }> {
    const { width, height } = await sharp(imageBuffer).metadata();
    if (!width || !height || width < 16 || height < 16) {
      const fallbackHash = await this.generateColorPHash(imageBuffer);
      return { q1: fallbackHash, q2: fallbackHash, q3: fallbackHash, q4: fallbackHash };
    }

    const w2 = Math.floor(width / 2), h2 = Math.floor(height / 2);

    const regions = [
      { left: 0, top: 0, width: w2, height: h2 },
      { left: w2, top: 0, width: width - w2, height: h2 },
      { left: 0, top: h2, width: w2, height: height - h2 },
      { left: w2, top: h2, width: width - w2, height: height - h2 },
    ];

    const [q1, q2, q3, q4] = await Promise.all(
        regions.map(region => {
          if (region.width < 8 || region.height < 8) return this.generateColorPHash(imageBuffer);
          return sharp(imageBuffer).extract(region).toBuffer().then(b => this.generateColorPHash(b));
        })
    );
    return { q1, q2, q3, q4 };
  }

  /**
   * @description 计算两个十六进制哈希字符串之间的汉明距离。
   * @param hex1 - 第一个十六进制哈希字符串。
   * @param hex2 - 第二个十六进制哈希字符串。
   * @returns {number} 两个哈希之间的距离。
   */
  public calculateHammingDistance(hex1: string, hex2: string): number {
    let distance = 0;
    const bin1 = hexToBinary(hex1);
    const bin2 = hexToBinary(hex2);
    const len = Math.min(bin1.length, bin2.length);
    for (let i = 0; i < len; i++) {
        if (bin1[i] !== bin2[i]) distance++;
    }
    return distance;
  }

  /**
   * @description 根据汉明距离计算图片或文本哈希的相似度。
   * @param hex1 - 第一个十六进制哈希字符串。
   * @param hex2 - 第二个十六进制哈希字符串。
   * @returns {number} 范围在0到1之间的相似度得分。
   */
  public calculateSimilarity(hex1: string, hex2: string): number {
    const distance = this.calculateHammingDistance(hex1, hex2);
    const hashLength = Math.max(hex1.length, hex2.length) * 4;
    return hashLength === 0 ? 1 : 1 - (distance / hashLength);
  }

  /**
   * @description 为文本生成基于 Simhash 算法的哈希字符串。
   * @param text - 需要处理的文本。
   * @returns {string} 64位二进制 Simhash 对应的16位十六进制字符串。
   */
  public generateTextSimhash(text: string): string {
    const cleanText = (text || '').toLowerCase().replace(/\s+/g, '');
    if (!cleanText) {
      return '';
    }

    const n = 2; // N-gram 的大小。
    const tokens = new Set<string>();

    if (cleanText.length < n) {
      tokens.add(cleanText);
    } else {
      for (let i = 0; i <= cleanText.length - n; i++) {
        tokens.add(cleanText.substring(i, i + n));
      }
    }

    const tokenArray = Array.from(tokens);
    if (tokenArray.length === 0) {
      return '';
    }

    const vector = new Array(64).fill(0);
    tokenArray.forEach(token => {
      const hash = crypto.createHash('md5').update(token).digest();
      for (let i = 0; i < 64; i++) {
        vector[i] += (hash[Math.floor(i / 8)]! >> (i % 8)) & 1 ? 1 : -1;
      }
    });

    const binaryHash = vector.map(v => v > 0 ? '1' : '0').join('');
    return BigInt('0b' + binaryHash).toString(16).padStart(16, '0');
  }
}

/**
 * @description 将十六进制字符串转换为二进制字符串的辅助函数。
 * @param hex - 十六进制字符串。
 * @returns 二进制字符串。
 */
function hexToBinary(hex: string): string {
    let bin = '';
    for (let i = 0; i < hex.length; i++) {
        bin += parseInt(hex[i]!, 16).toString(2).padStart(4, '0');
    }
    return bin;
}
