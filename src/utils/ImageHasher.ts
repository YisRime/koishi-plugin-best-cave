import sharp from 'sharp';
import { Buffer } from 'buffer';

/**
 * 图片哈希计算
 */
export class ImageHasher {
  /**
   * 计算图片哈希值
   */
  static async calculateHash(imageBuffer: Buffer): Promise<string> {
      // 转换为32x32灰度图以获得更好的特征
      const { data } = await sharp(imageBuffer)
        .grayscale()
        .resize(32, 32, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });

      // 应用Haar小波变换
      const waveletMatrix = this.haarWaveletTransform(data, 32);

      // 取左上角8x8区域作为特征区域
      const features = this.extractFeatures(waveletMatrix, 32);

      // 计算特征区域平均值
      const mean = features.reduce((sum, val) => sum + val, 0) / features.length;

      // 生成hash并转换为16进制
      const binaryHash = features.map(val => val > mean ? '1' : '0').join('');
      return this.binaryToHex(binaryHash);
  }

  private static binaryToHex(binary: string): string {
    const hex = [];
    // 每4位二进制转换为1位16进制
    for (let i = 0; i < binary.length; i += 4) {
      const chunk = binary.slice(i, i + 4);
      hex.push(parseInt(chunk, 2).toString(16));
    }
    return hex.join('');
  }

  private static hexToBinary(hex: string): string {
    let binary = '';
    for (const char of hex) {
      // 将每个16进制字符转为4位二进制
      const bin = parseInt(char, 16).toString(2).padStart(4, '0');
      binary += bin;
    }
    return binary;
  }

  private static haarWaveletTransform(data: Uint8Array, size: number): number[][] {
    const matrix: number[][] = Array(size).fill(0).map(() => Array(size).fill(0));

    // 将1D数组转为2D矩阵
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        matrix[i][j] = data[i * size + j];
      }
    }

    // 对行进行变换
    for (let i = 0; i < size; i++) {
      this.haarTransform1D(matrix[i]);
    }

    // 对列进行变换
    for (let j = 0; j < size; j++) {
      const col = matrix.map(row => row[j]);
      this.haarTransform1D(col);
      for (let i = 0; i < size; i++) {
        matrix[i][j] = col[i];
      }
    }

    return matrix;
  }

  private static haarTransform1D(arr: number[]): void {
    const len = arr.length;
    const temp = new Array(len).fill(0);

    for (let i = 0; i < len; i += 2) {
      if (i + 1 < len) {
        temp[i/2] = (arr[i] + arr[i+1]) / 2;
        temp[len/2 + i/2] = (arr[i] - arr[i+1]) / 2;
      } else {
        temp[i/2] = arr[i];
      }
    }

    for (let i = 0; i < len; i++) {
      arr[i] = temp[i];
    }
  }

  private static extractFeatures(matrix: number[][], size: number): number[] {
    const features: number[] = [];
    const featureSize = 8; // 提取8x8特征

    for (let i = 0; i < featureSize; i++) {
      for (let j = 0; j < featureSize; j++) {
        features.push(matrix[i][j]);
      }
    }

    return features;
  }

  /**
   * 计算两个hash值的汉明距离
   */
  static calculateDistance(hash1: string, hash2: string): number {
    if (hash1.length !== hash2.length) {
      throw new Error('Hash lengths must be equal');
    }

    // 转换为二进制后计算距离
    const bin1 = this.hexToBinary(hash1);
    const bin2 = this.hexToBinary(hash2);

    let distance = 0;
    for (let i = 0; i < bin1.length; i++) {
      if (bin1[i] !== bin2[i]) distance++;
    }
    return distance;
  }

  /**
   * 计算图片相似度(0-1)
   */
  static calculateSimilarity(hash1: string, hash2: string): number {
    const distance = this.calculateDistance(hash1, hash2);
    // 将汉明距离转换为0-1的相似度值
    // 64位hash的最大汉明距离是64
    return (64 - distance) / 64;
  }

  /**
   * 批量比较图片相似度
   */
  static batchCompareSimilarity(
    newHash: string,
    existingHashes: string[]
  ): number[] {
    return existingHashes.map(hash => this.calculateSimilarity(newHash, hash));
  }
}
