import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'koishi';
import { CaveObject, PendingCave } from '..';
import { FileHandler } from './FileHandler';

const logger = new Logger('IdManager');

/**
 * ID管理器类
 * 负责管理回声洞ID的分配、删除和统计信息
 */
export class IdManager {
  private deletedIds: Set<number> = new Set();
  private maxId: number = 0;
  private initialized: boolean = false;
  private readonly statusFilePath: string;
  private stats: Record<string, number[]> = {};
  private usedIds: Set<number> = new Set();

  /**
   * 初始化ID管理器
   * @param baseDir - 基础目录路径
   */
  constructor(baseDir: string) {
    const caveDir = path.join(baseDir, 'data', 'cave');
    this.statusFilePath = path.join(caveDir, 'status.json');
  }

  /**
   * 初始化ID管理系统
   * @param caveFilePath - 正式回声洞数据文件路径
   * @param pendingFilePath - 待处理回声洞数据文件路径
   * @throws 当初始化失败时抛出错误
   */
  async initialize(caveFilePath: string, pendingFilePath: string) {
    if (this.initialized) return;

    try {
      // 读取状态
      const status = fs.existsSync(this.statusFilePath) ?
        JSON.parse(await fs.promises.readFile(this.statusFilePath, 'utf8')) : {
          deletedIds: [],
          maxId: 0,
          stats: {},
          lastUpdated: new Date().toISOString()
        };

      // 读取数据
      const [caveData, pendingData] = await Promise.all([
        FileHandler.readJsonData<CaveObject>(caveFilePath),
        FileHandler.readJsonData<PendingCave>(pendingFilePath)
      ]);

      // 重置状态
      this.usedIds.clear();
      this.stats = {};
      const conflicts = new Map<number, Array<CaveObject | PendingCave>>();

      // 处理ID冲突和构建统计
      for (const data of [caveData, pendingData]) {
        for (const item of data) {
          // ID 冲突检查
          if (this.usedIds.has(item.cave_id)) {
            if (!conflicts.has(item.cave_id)) {
              conflicts.set(item.cave_id, []);
            }
            conflicts.get(item.cave_id)?.push(item);
          } else {
            this.usedIds.add(item.cave_id);

            // 只为正式数据构建统计
            if (data === caveData && item.contributor_number !== '10000') {
              if (!this.stats[item.contributor_number]) {
                this.stats[item.contributor_number] = [];
              }
              this.stats[item.contributor_number].push(item.cave_id);
            }
          }
        }
      }

      // 处理冲突
      if (conflicts.size > 0) {
        await this.handleConflicts(conflicts, caveFilePath, pendingFilePath, caveData, pendingData);
      }

      // 更新maxId，确保它不小于deletedIds中的最大值和已使用ID中的最大值
      this.maxId = Math.max(
        status.maxId || 0,
        ...[...this.usedIds],
        ...status.deletedIds || [],
        0
      );

      // 检测ID空缺并添加到deletedIds
      this.deletedIds = new Set(status.deletedIds || []);
      for (let i = 1; i <= this.maxId; i++) {
        if (!this.usedIds.has(i)) {
          this.deletedIds.add(i);
        }
      }

      // 保存更新后的状态
      await this.saveStatus();
      this.initialized = true;
      logger.success(`Cave ID Manager initialized with ${this.maxId}(-${this.deletedIds.size}) IDs`);

    } catch (error) {
      this.initialized = false;
      logger.error(`ID Manager initialization failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * 处理ID冲突
   * @param conflicts - ID冲突映射表
   * @param caveFilePath - 正式回声洞数据文件路径
   * @param pendingFilePath - 待处理回声洞数据文件路径
   * @param caveData - 正式回声洞数据
   * @param pendingData - 待处理回声洞数据
   * @private
   */
  private async handleConflicts(
    conflicts: Map<number, Array<CaveObject | PendingCave>>,
    caveFilePath: string,
    pendingFilePath: string,
    caveData: CaveObject[],
    pendingData: PendingCave[]
  ): Promise<void> {
    logger.warn(`Found ${conflicts.size} ID conflicts`);

    let modified = false;
    for (const items of conflicts.values()) {
      items.slice(1).forEach(item => {
        let newId = this.maxId + 1;
        while (this.usedIds.has(newId)) {
          newId++;
        }
        logger.info(`Reassigning ID: ${item.cave_id} -> ${newId}`);
        item.cave_id = newId;
        this.usedIds.add(newId);
        this.maxId = Math.max(this.maxId, newId);
        modified = true;
      });
    }

    if (modified) {
      await Promise.all([
        FileHandler.writeJsonData(caveFilePath, caveData),
        FileHandler.writeJsonData(pendingFilePath, pendingData)
      ]);
      logger.success('ID conflicts resolved');
    }
  }

  /**
   * 获取下一个可用的ID
   * @returns 下一个可用的ID
   * @throws 当ID管理器未初始化时抛出错误
   */
  getNextId(): number {
    if (!this.initialized) {
      throw new Error('IdManager not initialized');
    }

    let nextId: number;

    // 首先尝试从已删除的ID中获取最小值
    if (this.deletedIds.size > 0) {
      const minDeletedId = Math.min(...Array.from(this.deletedIds));
      if (!isNaN(minDeletedId) && minDeletedId > 0) {
        nextId = minDeletedId;
        this.deletedIds.delete(nextId);
      } else {
        // 如果已删除ID无效，则使用maxId + 1
        nextId = this.maxId + 1;
      }
    } else {
      // 没有已删除的ID时，使用maxId + 1
      nextId = this.maxId + 1;
    }

    // 确保ID为正整数且不重复
    while (isNaN(nextId) || nextId <= 0 || this.usedIds.has(nextId)) {
      nextId = this.maxId + 1;
      this.maxId++;
    }

    this.usedIds.add(nextId);

    // 异步保存状态，但不等待完成
    this.saveStatus().catch(err =>
      logger.error(`Failed to save status after getNextId: ${err.message}`)
    );

    return nextId;
  }

  /**
   * 标记ID为已删除状态
   * @param id - 要标记为删除的ID
   * @throws 当ID管理器未初始化时抛出错误
   */
  async markDeleted(id: number) {
    if (!this.initialized) {
      throw new Error('IdManager not initialized');
    }

    this.deletedIds.add(id);
    this.usedIds.delete(id);

    // 更新maxId时同时考虑usedIds和deletedIds中的最大值
    const maxUsedId = Math.max(...Array.from(this.usedIds), 0);
    const maxDeletedId = Math.max(...Array.from(this.deletedIds), 0);
    this.maxId = Math.max(maxUsedId, maxDeletedId);

    await this.saveStatus();
  }

  /**
   * 添加贡献统计
   * @param contributorNumber - 贡献者编号
   * @param caveId - 回声洞ID
   */
  async addStat(contributorNumber: string, caveId: number) {
    if (contributorNumber === '10000') return;
    if (!this.stats[contributorNumber]) {
      this.stats[contributorNumber] = [];
    }
    this.stats[contributorNumber].push(caveId);
    await this.saveStatus();
  }

  /**
   * 移除贡献统计
   * @param contributorNumber - 贡献者编号
   * @param caveId - 回声洞ID
   */
  async removeStat(contributorNumber: string, caveId: number) {
    if (this.stats[contributorNumber]) {
      this.stats[contributorNumber] = this.stats[contributorNumber].filter(id => id !== caveId);
      if (this.stats[contributorNumber].length === 0) {
        delete this.stats[contributorNumber];
      }
      await this.saveStatus();
    }
  }

  /**
   * 获取所有贡献统计信息
   * @returns 贡献者编号到回声洞ID列表的映射
   */
  getStats(): Record<string, number[]> {
    return this.stats;
  }

  /**
   * 保存当前状态到文件
   * @private
   * @throws 当保存失败时抛出错误
   */
  private async saveStatus(): Promise<void> {
    try {
      const status = {
        deletedIds: Array.from(this.deletedIds).sort((a, b) => a - b),
        maxId: this.maxId,
        stats: this.stats,
        lastUpdated: new Date().toISOString()
      };

      const tmpPath = `${this.statusFilePath}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(status, null, 2), 'utf8');
      await fs.promises.rename(tmpPath, this.statusFilePath);
    } catch (error) {
      logger.error(`Status save failed: ${error.message}`);
      throw error;
    }
  }
}
