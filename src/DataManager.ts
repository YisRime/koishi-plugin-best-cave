import { Context, Logger } from 'koishi';
import { FileManager } from './FileManager';
import { CaveObject, Config } from './index';
import { getNextCaveId } from './Utils';

/**
 * @description 用于数据导入/导出的可移植回声洞对象格式，排除了数据库自增的 `id`。
 */
type PortableCaveObject = Omit<CaveObject, 'id'>;

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
    // 导出数据子命令
    cave.subcommand('.export', '导出回声洞数据')
      .usage('将所有回声洞数据导出到 cave_export.json。')
      .action(async ({ session }) => {
        const adminChannelId = this.config.adminChannel ? this.config.adminChannel.split(':')[1] : null;
        if (session.channelId !== adminChannelId) return '此指令仅限在管理群组中使用';
        try {
          await session.send('正在导出数据，请稍候...');
          return await this.exportData();
        } catch (error) {
          this.logger.error('导出数据时发生错误:', error);
          return `导出失败: ${error.message}`;
        }
      });

    // 导入数据子命令
    cave.subcommand('.import', '导入回声洞数据')
      .usage('从 cave_import.json 中导入回声洞数据。')
      .action(async ({ session }) => {
        const adminChannelId = this.config.adminChannel ? this.config.adminChannel.split(':')[1] : null;
        if (session.channelId !== adminChannelId) return '此指令仅限在管理群组中使用';
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
   * @description 导出所有 'active' 状态的回声洞数据到 `cave_export.json`。
   * @returns 描述导出结果的消息字符串。
   */
  public async exportData(): Promise<string> {
    const fileName = 'cave_export.json';
    const cavesToExport = await this.ctx.database.get('cave', { status: 'active' });
    // 移除 id 字段，使其成为可移植对象。
    const portableCaves: PortableCaveObject[] = cavesToExport.map(({ id, ...rest }) => rest);
    const data = JSON.stringify(portableCaves, null, 2);
    await this.fileManager.saveFile(fileName, Buffer.from(data));
    return `成功导出 ${portableCaves.length} 条数据`;
  }

  /**
   * @description 从 `cave_import.json` 文件导入回声洞数据。
   * @returns 描述导入结果的消息字符串。
   */
  public async importData(): Promise<string> {
    const fileName = 'cave_import.json';
    let importedCaves: PortableCaveObject[];

    try {
      const fileContent = await this.fileManager.readFile(fileName);
      importedCaves = JSON.parse(fileContent.toString('utf-8'));
      if (!Array.isArray(importedCaves)) throw new Error('导入文件格式无效');
    } catch (error) {
      this.logger.error(`读取导入文件失败:`, error);
      return `读取导入文件失败: ${error.message || '未知错误'}`;
    }

    let successCount = 0;
    for (const cave of importedCaves) {
      // 逐条获取ID，在导入大量数据时可能有效率问题，但能确保ID的唯一性和连续性。
      const newId = await getNextCaveId(this.ctx, {});
      const newCave: CaveObject = {
        ...cave,
        id: newId,
        channelId: cave.channelId,
        status: 'active',
      };
      await this.ctx.database.create('cave', newCave);
      successCount++;
    }

    return `成功导入 ${successCount} 条回声洞数据`;
  }
}
