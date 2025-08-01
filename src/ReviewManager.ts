import { Context, h, Logger } from 'koishi';
import { CaveObject, Config } from './index';
import { FileManager } from './FileManager';
import { buildCaveMessage, cleanupPendingDeletions } from './Utils';

/**
 * @class ReviewManager
 * @description 负责处理回声洞的审核流程，处理新洞的提交、审核通知和审核操作。
 */
export class ReviewManager {
  /**
   * @constructor
   * @param ctx Koishi 上下文。
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
   * @description 注册与审核相关的 `.review` 子命令。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    cave.subcommand('.review [id:posint] [action:string]', '审核回声洞')
      .usage('查看或审核回声洞，使用 <Y/N> 进行审核。')
      .action(async ({ session }, id, action) => {
        if (session.channelId !== this.config.adminChannel) return '此指令仅限在管理群组中使用';

        if (!id) {
          const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' });
          if (pendingCaves.length === 0) return '当前没有需要审核的回声洞';
          return `当前共有 ${pendingCaves.length} 条待审核回声洞，序号为：\n${pendingCaves.map(c => c.id).join(', ')}`;
        }

        const [targetCave] = await this.ctx.database.get('cave', { id });
        if (!targetCave) return `回声洞（${id}）不存在`;
        if (targetCave.status !== 'pending') return `回声洞（${id}）无需审核`;

        if (id && !action) {
          return [`待审核：`, ...await buildCaveMessage(targetCave, this.config, this.fileManager, this.logger)];
        }

        const normalizedAction = action.toLowerCase();
        let reviewAction: 'approve' | 'reject';
        if (['y', 'yes', 'ok', 'pass', 'approve'].includes(normalizedAction)) reviewAction = 'approve';
        else if (['n', 'no', 'deny', 'reject'].includes(normalizedAction)) reviewAction = 'reject';
        else return `无效操作: "${action}"\n请使用 "Y" (通过) 或 "N" (拒绝)`;

        return this.processReview(reviewAction, id);
      });
  }

  /**
   * @description 将新回声洞提交到管理群组以供审核。
   * @param cave 新创建的、状态为 'pending' 的回声洞对象。
   */
  public async sendForReview(cave: CaveObject): Promise<void> {
    // 检查是否配置了管理群
    if (!this.config.adminChannel) {
      this.logger.warn(`未配置管理群组，已自动通过回声洞（${cave.id}）`);
      await this.ctx.database.upsert('cave', [{ id: cave.id, status: 'active' }]);
      return;
    }

    // 构建审核消息
    const reviewMessage = [`待审核：`, ...await buildCaveMessage(cave, this.config, this.fileManager, this.logger)];

    try {
      await this.ctx.broadcast([this.config.adminChannel], h.normalize(reviewMessage));
    } catch (error) {
      this.logger.error(`发送回声洞（${cave.id}）审核消息失败:`, error);
    }
  }

  /**
   * @description 处理管理员的审核决定（通过或拒绝）。
   * @param action 'approve' (通过) 或 'reject' (拒绝)。
   * @param caveId 被审核的回声洞 ID。
   * @returns 返回给操作者的确认消息。
   */
  public async processReview(action: 'approve' | 'reject', caveId: number): Promise<string> {
    const [cave] = await this.ctx.database.get('cave', { id: caveId, status: 'pending' });
    if (!cave) return `回声洞（${caveId}）无需审核`;

    let resultMessage: string;

    if (action === 'approve') {
      // 通过审核：更新状态为 'active'
      await this.ctx.database.upsert('cave', [{ id: caveId, status: 'active' }]);
      resultMessage = `回声洞（${caveId}）已通过`;
    } else {
      // 拒绝审核：标记为 'delete'
      await this.ctx.database.upsert('cave', [{ id: caveId, status: 'delete' }]);
      resultMessage = `回声洞（${caveId}）已拒绝`;
      // 异步触发清理，不阻塞当前响应
      cleanupPendingDeletions(this.ctx, this.fileManager, this.logger);
    }

    return resultMessage;
  }
}
