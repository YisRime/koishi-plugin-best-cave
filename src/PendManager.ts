import { Context, h, Logger } from 'koishi';
import { CaveObject, Config } from './index';
import { FileManager } from './FileManager';
import { buildCaveMessage, cleanupPendingDeletions } from './Utils';

/**
 * @class PendManager
 * @description 负责处理回声洞的审核流程，处理新洞的提交、审核通知和审核操作。
 */
export class PendManager {
  /**
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
    const requireAdmin = (session) => {
      if (session.channelId !== this.config.adminChannel?.split(':')[1]) {
        return '此指令仅限在管理群组中使用';
      }
      return null;
    };

    const pend = cave.subcommand('.pend [id:posint]', '审核回声洞')
      .action(async ({ session }, id) => {
        const adminError = requireAdmin(session);
        if (adminError) return adminError;

        if (id) {
          const [targetCave] = await this.ctx.database.get('cave', { id });
          if (!targetCave) return `回声洞（${id}）不存在`;
          if (targetCave.status !== 'pending') return `回声洞（${id}）无需审核`;
          return [`待审核`, ...await buildCaveMessage(targetCave, this.config, this.fileManager, this.logger)];
        }

        const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' }, { fields: ['id'] });
        if (!pendingCaves.length) return '当前没有需要审核的回声洞';
        return `当前共有 ${pendingCaves.length} 条待审核回声洞，序号为：\n${pendingCaves.map(c => c.id).join('|')}`;
      });

    const createPendAction = (actionType: 'approve' | 'reject') => async ({ session }, id?: number) => {
      const adminError = requireAdmin(session);
      if (adminError) return adminError;

      try {
        const targetStatus = actionType === 'approve' ? 'active' : 'delete';
        const actionText = actionType === 'approve' ? '通过' : '拒绝';

        // 批量处理
        if (!id) {
          const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' });
          if (!pendingCaves.length) return `当前没有需要${actionText}的回声洞`;

          await this.ctx.database.upsert('cave', pendingCaves.map(c => ({ id: c.id, status: targetStatus })));
          if (targetStatus === 'delete') cleanupPendingDeletions(this.ctx, this.fileManager, this.logger, this.reusableIds);
          return `已批量${actionText} ${pendingCaves.length} 条回声洞`;
        }

        // 单个处理
        const [cave] = await this.ctx.database.get('cave', { id, status: 'pending' });
        if (!cave) return `回声洞（${id}）无需审核`;

        await this.ctx.database.upsert('cave', [{ id, status: targetStatus }]);
        if (targetStatus === 'delete') cleanupPendingDeletions(this.ctx, this.fileManager, this.logger, this.reusableIds);
        return `回声洞（${id}）已${actionText}`;

      } catch (error) {
        this.logger.error(`审核操作失败:`, error);
        return `操作失败: ${error.message}`;
      }
    };

    pend.subcommand('.Y [id:posint]', '通过审核').action(createPendAction('approve'));
    pend.subcommand('.N [id:posint]', '拒绝审核').action(createPendAction('reject'));
  }

  /**
   * @description 将新回声洞提交到管理群组以供审核。
   * @param cave 新创建的、状态为 'pending' 的回声洞对象。
   */
  public async sendForPend(cave: CaveObject): Promise<void> {
    if (!this.config.adminChannel?.includes(':')) {
      this.logger.warn(`管理群组配置无效，已自动通过回声洞（${cave.id}）`);
      await this.ctx.database.upsert('cave', [{ id: cave.id, status: 'active' }]);
      return;
    }
    try {
      const pendMessage = [`待审核`, ...await buildCaveMessage(cave, this.config, this.fileManager, this.logger)];
      await this.ctx.broadcast([this.config.adminChannel], h.normalize(pendMessage));
    } catch (error) {
      this.logger.error(`发送回声洞（${cave.id}）审核消息失败:`, error);
    }
  }
}
