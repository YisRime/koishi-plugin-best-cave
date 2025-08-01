import { Context, Logger } from 'koishi';
import { FileManager } from './FileManager';
import { CaveObject, Config } from './index';
import { getNextCaveId } from './Utils';

/**
 * 可移植的回声洞对象格式，用于数据导入/导出。
 * 它排除了数据库自动生成的 `id` 字段。
 */
type PortableCaveObject = Omit<CaveObject, 'id'>;

/**
 * 数据管理器 (DataManager)
 * @description
 * 负责处理回声洞数据的导入和导出功能。
 */
export class DataManager {
  /**
   * 创建一个 DataManager 实例。
   * @param ctx - Koishi 上下文，用于数据库操作。
   * @param config - 插件配置。
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
   * @param cave - 主 `cave` 命令的实例，用于挂载子命令。
   */
  public registerCommands(cave) {
    // 导出数据子命令
    cave.subcommand('.export', '导出回声洞数据')
      .usage('将所有回声洞数据导出到 cave_export.json。')
      .action(async ({ session }) => {
        // 权限检查
        if (!this.config.adminUsers.includes(session.userId)) return '抱歉，你没有权限导出数据';
        try {
          await session.send('正在导出数据，请稍候...');
          const resultMessage = await this.exportData();
          return resultMessage;
        } catch (error) {
          this.logger.error('导出数据时发生错误:', error);
          return `导出失败: ${error.message}`;
        }
      });

    // 导入数据子命令
    cave.subcommand('.import', '导入回声洞数据')
      .usage('从 cave_import.json 中导入回声洞数据。')
      .action(async ({ session }) => {
        // 权限检查
        if (!this.config.adminUsers.includes(session.userId)) return '抱歉，你没有权限导入数据';
        try {
          await session.send('正在导入数据，请稍候...');
          const resultMessage = await this.importData();
          return resultMessage;
        } catch (error) {
          this.logger.error('导入数据时发生错误:', error);
          return `导入失败: ${error.message}`;
        }
      });
  }

  /**
   * 导出所有状态为 'active' 的回声洞数据。
   * 数据将被序列化为 JSON 并保存到 `cave_export.json` 文件中。
   * @returns 一个描述导出结果的字符串消息。
   */
  public async exportData(): Promise<string> {
    const fileName = 'cave_export.json';
    // 从数据库中获取所有活动状态的回声洞。
    const cavesToExport = await this.ctx.database.get('cave', { status: 'active' });

    // 将数据库对象转换为可移植的格式（移除 id）。
    const portableCaves: PortableCaveObject[] = cavesToExport.map(({ id, ...rest }) => rest);

    // 将数据格式化为易于阅读的 JSON 字符串。
    const data = JSON.stringify(portableCaves, null, 2);
    // 使用 FileManager 保存文件。
    await this.fileManager.saveFile(fileName, Buffer.from(data));

    return `成功导出 ${portableCaves.length} 条数据`;
  }

  /**
   * 从 `cave_import.json` 文件导入回声洞数据。
   * @returns 一个描述导入结果的字符串消息。
   */
  public async importData(): Promise<string> {
    const fileName = 'cave_import.json';
    let importedCaves: PortableCaveObject[];

    try {
      // 使用 FileManager 读取导入文件。
      const fileContent = await this.fileManager.readFile(fileName);
      // 解析 JSON 内容。
      importedCaves = JSON.parse(fileContent.toString('utf-8'));
      if (!Array.isArray(importedCaves)) {
        throw new Error('导入文件格式无效');
      }
    } catch (error) {
      this.logger.error(`读取导入文件失败:`, error);
      return `读取导入文件失败: ${error.message || '未知错误'}`;
    }

    let successCount = 0;
    // 遍历解析出的每一条回声洞数据。
    for (const cave of importedCaves) {
      // 为每条新洞获取一个全局唯一的、最小的可用 ID。
      const newId = await getNextCaveId(this.ctx, {});
      // 构建完整的数据库对象。
      const newCave: CaveObject = {
        ...cave,
        id: newId,
        channelId: cave.channelId || null, // 确保 channelId 存在，若无则为 null。
        status: 'active', // 导入的数据直接设为 active 状态。
      };
      // 创建数据库记录。
      await this.ctx.database.create('cave', newCave);
      successCount++;
    }

    return `成功导入 ${successCount} 条回声洞数据`;
  }
}
