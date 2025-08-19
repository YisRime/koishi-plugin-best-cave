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
  type: 'simhash' | 'phash';
}

/**
 * @class HashManager
 * @description 负责生成、存储和比较文本与图片的哈希值。
 * 实现了基于 Simhash 的文本查重和基于 DCT 感知哈希 (pHash) 的图片查重方案。
 */
export class HashManager {

  /**
   * @constructor
   * @param ctx - Koishi 上下文，用于数据库操作。
   * @param config - 插件配置，用于获取相似度阈值等。
   * @param logger - 日志记录器实例。
   * @param fileManager - 文件管理器实例，用于读取图片文件。
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
      indexes: ['type'],
    });
  }

  /**
   * @description 注册与哈希功能相关的 `.hash` 和 `.check` 子命令。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    const adminCheck = ({ session }) => {
      const adminChannelId = this.config.adminChannel?.split(':')[1];
      if (session.channelId !== adminChannelId) return '此指令仅限在管理群组中使用';
    };

    cave.subcommand('.hash', '校验回声洞', { hidden: true , authority: 3 })
      .usage('校验缺失哈希的回声洞，补全哈希记录。')
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

    cave.subcommand('.check', '检查相似度', { hidden: true })
      .usage('检查所有回声洞，找出相似度过高的内容。')
      .option('textThreshold', '-t <threshold:number> 文本相似度阈值 (%)')
      .option('imageThreshold', '-i <threshold:number> 图片相似度阈值 (%)')
      .action(async (argv) => {
        const checkResult = adminCheck(argv);
        if (checkResult) return checkResult;
        await argv.session.send('正在检查，请稍候...');
        try {
          return await this.checkForSimilarCaves(argv.options);
        } catch (error) {
          this.logger.error('检查相似度失败:', error);
          return `检查失败: ${error.message}`;
        }
      });
  }

  /**
   * @description 检查数据库中所有回声洞，为没有哈希记录的历史数据生成哈希。
   * @returns 一个包含操作结果的报告字符串。
   */
  public async generateHashesForHistoricalCaves(): Promise<string> {
    const allCaves = await this.ctx.database.get('cave', { status: 'active' });
    const existingHashes = await this.ctx.database.get('cave_hash', {});
    const existingHashSet = new Set(existingHashes.map(h => `${h.cave}-${h.hash}-${h.type}`));
    if (allCaves.length === 0) return '无需补全回声洞哈希';
    this.logger.info(`开始补全 ${allCaves.length} 个回声洞的哈希...`);
    let hashesToInsert: CaveHashObject[] = [];
    let processedCaveCount = 0;
    let totalHashesGenerated = 0;
    let errorCount = 0;
    const flushBatch = async () => {
      if (hashesToInsert.length === 0) return;
      await this.ctx.database.upsert('cave_hash', hashesToInsert);
      totalHashesGenerated += hashesToInsert.length;
      this.logger.info(`[${processedCaveCount}/${allCaves.length}] 正在导入 ${hashesToInsert.length} 条回声洞哈希...`);
      hashesToInsert = [];
    };
    for (const cave of allCaves) {
      processedCaveCount++;
      try {
        const newHashesForCave = await this.generateAllHashesForCave(cave);
        for (const hashObj of newHashesForCave) {
          const uniqueKey = `${hashObj.cave}-${hashObj.hash}-${hashObj.type}`;
          if (!existingHashSet.has(uniqueKey)) {
            hashesToInsert.push(hashObj);
            existingHashSet.add(uniqueKey);
          }
        }
        if (hashesToInsert.length >= 100) await flushBatch();
      } catch (error) {
        errorCount++;
        this.logger.warn(`补全回声洞（${cave.id}）哈希时发生错误: ${error.message}`);
      }
    }
    await flushBatch();
    return `已补全 ${allCaves.length} 个回声洞的 ${totalHashesGenerated} 条哈希（失败 ${errorCount} 条）`;
  }

  /**
   * @description 为单个回声洞对象生成所有类型的哈希（文本+图片）。
   * @param cave - 回声洞对象。
   * @returns 生成的哈希对象数组。
   */
  public async generateAllHashesForCave(cave: Pick<CaveObject, 'id' | 'elements'>): Promise<CaveHashObject[]> {
    const tempHashes: CaveHashObject[] = [];
    const uniqueHashTracker = new Set<string>();
    const addUniqueHash = (hashObj: CaveHashObject) => {
        const key = `${hashObj.hash}-${hashObj.type}`;
        if (!uniqueHashTracker.has(key)) {
            tempHashes.push(hashObj);
            uniqueHashTracker.add(key);
        }
    }
    const combinedText = cave.elements.filter(el => el.type === 'text' && el.content).map(el => el.content).join(' ');
    if (combinedText) {
      const textHash = this.generateTextSimhash(combinedText);
      if (textHash) addUniqueHash({ cave: cave.id, hash: textHash, type: 'simhash' });
    }
    for (const el of cave.elements.filter(el => el.type === 'image' && el.file)) {
      try {
        const imageBuffer = await this.fileManager.readFile(el.file);
        const imageHash = await this.generatePHash(imageBuffer, 256);
        addUniqueHash({ cave: cave.id, hash: imageHash, type: 'phash' });
      } catch (e) {
        this.logger.warn(`无法为回声洞（${cave.id}）的图片（${el.file}）生成哈希:`, e);
      }
    }
    return tempHashes;
  }

  /**
   * @description 对数据库中所有哈希进行两两比较，找出相似度过高的内容。
   * @param options 包含临时阈值的可选对象。
   * @returns 一个包含检查结果的报告字符串。
   */
  public async checkForSimilarCaves(options: { textThreshold?: number; imageThreshold?: number } = {}): Promise<string> {
    const textThreshold = options.textThreshold ?? this.config.textThreshold;
    const imageThreshold = options.imageThreshold ?? this.config.imageThreshold;
    const allHashes = await this.ctx.database.get('cave_hash', {});
    const allCaveIds = [...new Set(allHashes.map(h => h.cave))];
    const textHashes = new Map<number, string>();
    const imageHashes = new Map<number, string>();
    for (const hash of allHashes) {
      if (hash.type === 'simhash') {
        textHashes.set(hash.cave, hash.hash);
      } else if (hash.type === 'phash') {
        imageHashes.set(hash.cave, hash.hash);
      }
    }
    const similarPairs = {
      text: new Set<string>(),
      image: new Set<string>(),
    };
    for (let i = 0; i < allCaveIds.length; i++) {
      for (let j = i + 1; j < allCaveIds.length; j++) {
        const id1 = allCaveIds[i];
        const id2 = allCaveIds[j];
        const pair = [id1, id2].sort((a, b) => a - b).join(' & ');
        // 比较文本哈希 (Simhash)
        const text1 = textHashes.get(id1);
        const text2 = textHashes.get(id2);
        if (text1 && text2) {
          const similarity = this.calculateSimilarity(text1, text2);
          if (similarity >= textThreshold) similarPairs.text.add(`${pair} = ${similarity.toFixed(2)}%`);
        }
        // 比较图片哈希 (pHash)
        const image1 = imageHashes.get(id1);
        const image2 = imageHashes.get(id2);
        if (image1 && image2) {
          const similarity = this.calculateSimilarity(image1, image2);
          if (similarity >= imageThreshold) similarPairs.image.add(`${pair} = ${similarity.toFixed(2)}%`);
        }
      }
    }
    const totalFindings = similarPairs.text.size + similarPairs.image.size;
    if (totalFindings === 0) return '未发现高相似度的内容';
    let report = `已发现 ${totalFindings} 组高相似度的内容:`;
    if (similarPairs.text.size > 0) report += '\n文本内容相似:\n' + [...similarPairs.text].join('\n');
    if (similarPairs.image.size > 0) report += '\n图片内容相似:\n' + [...similarPairs.image].join('\n');
    return report.trim();
  }

  /**
   * @description 执行二维离散余弦变换 (DCT-II)。
   * @param matrix - 输入的 N x N 像素亮度矩阵。
   * @returns DCT变换后的 N x N 系数矩阵。
   */
  private _dct2D(matrix: number[][]): number[][] {
    const N = matrix.length;
    if (N === 0) return [];
    const cosines = Array.from({ length: N }, (_, i) =>
      Array.from({ length: N }, (_, j) => Math.cos((Math.PI * (2 * i + 1) * j) / (2 * N)))
    );
    const applyDct1D = (input: number[]): number[] => {
      const output = new Array(N).fill(0);
      const scale = Math.sqrt(2 / N);
      for (let k = 0; k < N; k++) {
        let sum = 0;
        for (let n = 0; n < N; n++) sum += input[n] * cosines[n][k];
        output[k] = scale * sum;
      }
      output[0] /= Math.sqrt(2);
      return output;
    };
    const tempMatrix = matrix.map(row => applyDct1D(row));
    const transposed = tempMatrix[0].map((_, col) => tempMatrix.map(row => row[col]));
    const dctResult = transposed.map(row => applyDct1D(row));
    return dctResult[0].map((_, col) => dctResult.map(row => row[col]));
  }

  /**
   * @description pHash 算法核心实现。
   * @param imageBuffer - 图片的Buffer。
   * @param size - 期望的哈希位数 (必须是完全平方数, 如 64 或 256)。
   * @returns 十六进制pHash字符串。
   */
  public async generatePHash(imageBuffer: Buffer, size: number): Promise<string> {
    const dctSize = 32;
    const hashGridSize = Math.sqrt(size);
    if (!Number.isInteger(hashGridSize)) throw new Error('哈希位数必须是完全平方数');
    const pixels = await sharp(imageBuffer).grayscale().resize(dctSize, dctSize, { fit: 'fill' }).raw().toBuffer();
    const matrix: number[][] = [];
    for (let y = 0; y < dctSize; y++) matrix.push(Array.from(pixels.slice(y * dctSize, (y + 1) * dctSize)));
    const dctMatrix = this._dct2D(matrix);
    const coefficients: number[] = [];
    for (let y = 0; y < hashGridSize; y++) for (let x = 0; x < hashGridSize; x++) coefficients.push(dctMatrix[y][x]);
    const median = [...coefficients.slice(1)].sort((a, b) => a - b)[Math.floor((coefficients.length -1) / 2)];
    const binaryHash = coefficients.map(val => val > median ? '1' : '0').join('');
    return BigInt('0b' + binaryHash).toString(16).padStart(size / 4, '0');
  }

  /**
   * @description 计算两个十六进制哈希字符串之间的汉明距离 (不同位的数量)。
   * @param hex1 - 第一个哈希。
   * @param hex2 - 第二个哈希。
   * @returns 汉明距离。
   */
  public calculateHammingDistance(hex1: string, hex2: string): number {
    let distance = 0;
    const bin1 = hexToBinary(hex1);
    const bin2 = hexToBinary(hex2);
    const len = Math.min(bin1.length, bin2.length);
    for (let i = 0; i < len; i++) if (bin1[i] !== bin2[i]) distance++;
    return distance;
  }

  /**
   * @description 根据汉明距离计算相似度百分比。
   * @param hex1 - 第一个哈希。
   * @param hex2 - 第二个哈希。
   * @returns 相似度 (0-100)。
   */
  public calculateSimilarity(hex1: string, hex2: string): number {
    const distance = this.calculateHammingDistance(hex1, hex2);
    const hashLength = Math.max(hex1.length, hex2.length) * 4;
    return hashLength === 0 ? 100 : (1 - (distance / hashLength)) * 100;
  }

  /**
   * @description 为文本生成 64 位 Simhash 字符串。
   * @param text - 需要处理的文本。
   * @returns 16位十六进制 Simhash 字符串。
   */
  public generateTextSimhash(text: string): string {
    const cleanText = (text || '').toLowerCase().replace(/\s+/g, '');
    if (!cleanText) return '';
    const n = 2;
    const tokens = new Set<string>();
    if (cleanText.length < n) {
      tokens.add(cleanText);
    } else {
      for (let i = 0; i <= cleanText.length - n; i++) tokens.add(cleanText.substring(i, i + n));
    }
    const tokenArray = Array.from(tokens);
    if (tokenArray.length === 0) return '';
    const vector = new Array(64).fill(0);
    tokenArray.forEach(token => {
      const hash = crypto.createHash('md5').update(token).digest();
      for (let i = 0; i < 64; i++) vector[i] += (hash[Math.floor(i / 8)]! >> (i % 8)) & 1 ? 1 : -1;
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
  for (const char of hex) bin += parseInt(char, 16).toString(2).padStart(4, '0');
  return bin;
}
