import { Context, Logger } from 'koishi';
import { FileManager } from './FileManager';
import { CaveObject, Config } from './index';

/**
 * @class DataManager
 * @description 负责处理回声洞数据的导入和导出功能。
 */
export class DataManager {
  /**
   * @constructor
   * @param ctx Koishi 上下文，用于数据库操作。
   * @param config 插件配置。
   * @param fileManager 文件管理器实例。
   * @param logger 日志记录器实例。
   */
  constructor(
    private ctx: Context,
    private config: Config,
    private fileManager: FileManager,
    private logger: Logger,
  ) {}

  /**
   * @description 注册 `.export` 和 `.import` 子命令。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    const requireAdmin = (action: () => Promise<string>) => async ({ session }) => {
      if (session.channelId !== this.config.adminChannel?.split(':')[1]) return '此指令仅限在管理群组中使用';
      try {
        await session.send('正在处理，请稍候...');
        return await action();
      } catch (error) {
        this.logger.error('数据操作时发生错误:', error);
        return `操作失败: ${error.message}`;
      }
    };

    cave.subcommand('.export', '导出回声洞数据', { hidden: true , authority: 4 })
      .usage('将所有回声洞数据导出到 cave_export.json 中。')
      .action(requireAdmin(() => this.exportData()));
    cave.subcommand('.import', '导入回声洞数据', { hidden: true , authority: 4 })
      .usage('从 cave_import.json 中导入回声洞数据。')
      .action(requireAdmin(() => this.importData()));
  }

  /**
   * @description 导出所有 'active' 状态的回声洞数据到 `cave_export.json`。
   * @returns 描述导出结果的消息字符串。
   */
  public async exportData(): Promise<string> {
    const fileName = 'cave_export.json';
    const cavesToExport = await this.ctx.database.get('cave', { status: 'active' });
    await this.fileManager.saveFile(fileName, Buffer.from(JSON.stringify(cavesToExport, null, 2)));
    return `成功导出 ${cavesToExport.length} 条数据`;
  }

  /**
   * @description 从 `cave_import.json` 文件导入回声洞数据。
   * @returns 描述导入结果的消息字符串。
   */
  public async importData(): Promise<string> {
    const fileName = 'cave_import.json';
    let importedCaves: CaveObject[];
    try {
      const fileContent = await this.fileManager.readFile(fileName);
      importedCaves = JSON.parse(fileContent.toString('utf-8'));
      if (!Array.isArray(importedCaves) || !importedCaves.length) throw new Error('导入文件格式无效或为空');
    } catch (error) {
      throw new Error(`读取导入文件失败: ${error.message}`);
    }
    const allDbCaves = await this.ctx.database.get('cave', {}, { fields: ['id'] });
    const existingIds = new Set(allDbCaves.map(c => c.id));
    let maxId = allDbCaves.length > 0 ? Math.max(...allDbCaves.map(c => c.id)) : 0;
    const nonConflictingCaves: CaveObject[] = [];
    const conflictingCaves: CaveObject[] = [];
    let invalidCount = 0;
    for (const importedCave of importedCaves) {
      if (typeof importedCave.id !== 'number' || !Array.isArray(importedCave.elements)) {
        this.logger.warn(`回声洞（${importedCave.id}）无效: ${JSON.stringify(importedCave)}`);
        invalidCount++;
        continue;
      }
      if (existingIds.has(importedCave.id)) {
        conflictingCaves.push(importedCave);
      } else {
        nonConflictingCaves.push({ ...importedCave, status: 'active' });
        existingIds.add(importedCave.id);
        maxId = Math.max(maxId, importedCave.id);
      }
    }
    const newCavesFromConflicts: CaveObject[] = conflictingCaves.map(cave => {
      maxId++;
      this.logger.info(`回声洞（${cave.id}）已转移至（${maxId}）`);
      return { ...cave, maxId, status: 'active' };
    });
    const finalCavesToUpsert = [...nonConflictingCaves, ...newCavesFromConflicts];
    if (finalCavesToUpsert.length > 0) await this.ctx.database.upsert('cave', finalCavesToUpsert);
    return `成功导入 ${finalCavesToUpsert.length} 条数据`;
  }
}
