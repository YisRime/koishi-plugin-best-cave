import { Context, Logger } from 'koishi';
import { FileManager } from './FileManager';
import { CaveObject, Config } from './index';

/**
 * @type PortableCaveObject
 * @description 用于数据导入/导出的可移植回声洞对象格式，不包含数据库自增的 `id` 字段。
 */
type PortableCaveObject = Omit<CaveObject, 'id'>;

/**
 * @class DataManager
 * @description 负责处理回声洞数据的导入和导出功能，提供数据迁移和备份的能力。
 */
export class DataManager {
  /**
   * @param ctx - Koishi 上下文，用于数据库操作。
   * @param config - 插件配置对象。
   * @param fileManager - 文件管理器实例，用于读写导入/导出文件。
   * @param logger - 日志记录器实例。
   */
  constructor(
    private ctx: Context,
    private config: Config,
    private fileManager: FileManager,
    private logger: Logger,
  ) {}

  /**
   * 注册与数据导入导出相关的 `.export` 和 `.import` 子命令。
   * @param cave - 主 `cave` 命令实例，用于挂载子命令。
   */
  public registerCommands(cave) {
    cave.subcommand('.export', '导出回声洞数据')
      .usage('将所有回声洞数据导出到 cave_export.json。')
      .action(async ({ session }) => {
        if (!this.config.adminUsers.includes(session.userId)) return '抱歉，你没有权限导出数据';
        try {
          await session.send('正在导出数据，请稍候...');
          return await this.exportData();
        } catch (error) {
          this.logger.error('导出数据时发生错误:', error);
          return `导出失败: ${error.message}`;
        }
      });

    cave.subcommand('.import', '导入回声洞数据')
      .usage('从 cave_import.json 中导入回声洞数据。')
      .action(async ({ session }) => {
        if (!this.config.adminUsers.includes(session.userId)) return '抱歉，你没有权限导入数据';
        try {
          await session.send('正在导入数据，请稍候...');
          return await this.importData();
        } catch (error) {
          this.logger.error('导入数据时发生错误:', error);
          return `导入失败: ${error.message}`;
        }
      });
  }

  /**
   * 导出所有状态为 'active' 的回声洞数据到 `cave_export.json` 文件。
   * @returns 一个描述导出结果的字符串消息。
   */
  public async exportData(): Promise<string> {
    const fileName = 'cave_export.json';
    const cavesToExport = await this.ctx.database.get('cave', { status: 'active' });

    const portableCaves: PortableCaveObject[] = cavesToExport.map(({ id, ...rest }) => rest);

    const data = JSON.stringify(portableCaves, null, 2);
    await this.fileManager.saveFile(fileName, Buffer.from(data));

    return `成功导出 ${portableCaves.length} 条数据`;
  }

  /**
   * 从 `cave_import.json` 文件导入回声洞数据。
   * @returns 一个描述导入结果的字符串消息。
   */
  public async importData(): Promise<string> {
    const fileName = 'cave_import.json';
    let importedData: PortableCaveObject[];

    try {
      const fileContent = await this.fileManager.readFile(fileName);
      importedData = JSON.parse(fileContent.toString('utf-8'));
      if (!Array.isArray(importedData)) {
        throw new Error('导入文件格式非 JSON 数组');
      }
    } catch (error) {
      return `读取导入文件失败: ${error.message}`;
    }

    const allCaves = await this.ctx.database.get('cave', {}, { fields: ['id'] });
    const existingIds = new Set(allCaves.map(c => c.id));
    let nextId = 1;

    const cavesToCreate: CaveObject[] = [];

    for (const caveData of importedData) {
      while (existingIds.has(nextId)) {
        nextId++;
      }
      const newId = nextId;

      const newCave: CaveObject = {
        ...caveData,
        id: newId,
        channelId: caveData.channelId,
        status: 'active',
      };
      cavesToCreate.push(newCave);

      existingIds.add(newId);
    }

    if (cavesToCreate.length > 0) {
        await this.ctx.database.upsert('cave', cavesToCreate);
    }

    return `成功导入 ${cavesToCreate.length} 条回声洞数据`;
  }
}
