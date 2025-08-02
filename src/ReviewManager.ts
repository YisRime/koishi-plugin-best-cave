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
   * @param reusableIds 可复用 ID 的内存缓存。
   */
  constructor(
    private ctx: Context,
    private config: Config,
    private fileManager: FileManager,
    private logger: Logger,
    private reusableIds: Set<number>,
  ) {}

  /**
   * @description 注册与审核相关的子命令。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    // 统一的管理员权限检查
    const requireAdmin = (session) => {
      const adminChannelId = this.config.adminChannel?.split(':')[1];
      if (session.channelId !== adminChannelId) {
        return '此指令仅限在管理群组中使用';
      }
      return null;
    };

    const review = cave.subcommand('.review [id:posint]', '审核回声洞')
      .usage('查看所有待审核回声洞，或查看指定待审核回声洞。')
      .action(async ({ session }, id) => {
        const adminError = requireAdmin(session);
        if (adminError) return adminError;

        if (!id) {
          const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' }, { fields: ['id'] });
          if (!pendingCaves.length) return '当前没有需要审核的回声洞';
          return `当前共有 ${pendingCaves.length} 条待审核回声洞，序号为：\n${pendingCaves.map(c => c.id).join('|')}`;
        }

        const [targetCave] = await this.ctx.database.get('cave', { id });
        if (!targetCave) return `回声洞（${id}）不存在`;
        if (targetCave.status !== 'pending') return `回声洞（${id}）无需审核`;

        return [`待审核`, ...await buildCaveMessage(targetCave, this.config, this.fileManager, this.logger)];
      });

    const createReviewAction = (actionType: 'approve' | 'reject') => async ({ session }, id: number) => {
      const adminError = requireAdmin(session);
      if (adminError) return adminError;

      try {
        if (!id) {
          const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' });
          if (!pendingCaves.length) return `当前没有需要${actionType === 'approve' ? '通过' : '拒绝'}的回声洞`;

          if (actionType === 'approve') {
            await this.ctx.database.upsert('cave', pendingCaves.map(c => ({ id: c.id, status: 'active' })));
            return `已通过 ${pendingCaves.length} 条回声洞`;
          } else {
            await this.ctx.database.upsert('cave', pendingCaves.map(c => ({ id: c.id, status: 'delete' })));
            cleanupPendingDeletions(this.ctx, this.fileManager, this.logger, this.reusableIds);
            return `已拒绝 ${pendingCaves.length} 条回声洞`;
          }
        }

        return this.processReview(actionType, id);

      } catch (error) {
        this.logger.error(`审核操作失败:`, error);
        return `操作失败: ${error.message}`;
      }
    };

    review.subcommand('.Y [id:posint]', '通过审核')
      .usage('通过回声洞审核，可批量操作。')
      .action(createReviewAction('approve'));

    review.subcommand('.N [id:posint]', '拒绝审核')
      .usage('拒绝回声洞审核，可批量操作。')
      .action(createReviewAction('reject'));
  }

  /**
   * @description 将新回声洞提交到管理群组以供审核。
   * @param cave 新创建的、状态为 'pending' 的回声洞对象。
   */
  public async sendForReview(cave: CaveObject): Promise<void> {
    if (!this.config.adminChannel?.includes(':')) {
      this.logger.warn(`管理群组配置无效，已自动通过回声洞（${cave.id}）`);
      await this.ctx.database.upsert('cave', [{ id: cave.id, status: 'active' }]);
      return;
    }

    try {
      const reviewMessage = [`待审核`, ...await buildCaveMessage(cave, this.config, this.fileManager, this.logger)];
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

    if (action === 'approve') {
      await this.ctx.database.upsert('cave', [{ id: caveId, status: 'active' }]);
      return `回声洞（${caveId}）已通过`;
    } else {
      await this.ctx.database.upsert('cave', [{ id: caveId, status: 'delete' }]);
      // 异步触发清理，不阻塞当前响应
      cleanupPendingDeletions(this.ctx, this.fileManager, this.logger, this.reusableIds);
      return `回声洞（${caveId}）已拒绝`;
    }
  }
}
