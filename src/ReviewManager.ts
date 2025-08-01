import { Context, h, Logger } from 'koishi';
import { CaveObject, Config } from './index';
import { FileManager } from './FileManager';
import { buildCaveMessage, cleanupPendingDeletions } from './Utils'; // Import cleanup function

const APPROVE_ACTIONS = new Set(['y', 'yes', 'pass', 'approve']);
const REJECT_ACTIONS = new Set(['n', 'no', 'deny', 'reject']);

/**
 * @class ReviewManager
 * @description 负责处理回声洞的审核流程。
 * 此管理器将处理新回声洞的提交、向管理员发送审核通知，并响应管理员的审核操作。
 */
export class ReviewManager {
  /**
   * @param ctx - Koishi 上下文。
   * @param config - 插件配置对象。
   * @param fileManager - 文件管理器实例。
   * @param logger - 日志记录器实例。
   */
  constructor(
    private ctx: Context,
    private config: Config,
    private fileManager: FileManager,
    private logger: Logger,
  ) {}

  /**
   * 注册与审核相关的 `.review` 子命令。
   * @param cave - 主 `cave` 命令实例，用于挂载子命令。
   */
  public registerCommands(cave) {
    cave.subcommand('.review [id:posint] [action:string]', '审核回声洞')
      .usage('查看或审核回声洞，使用 <Y/N> 进行审核。')
      .action(async ({ session }, id, action) => {
        if (!this.config.adminUsers.includes(session.userId)) {
          return '抱歉，你没有权限执行审核';
        }

        if (!id) {
          return this.listPendingCaves();
        }

        const [targetCave] = await this.ctx.database.get('cave', { id });
        if (!targetCave) return `回声洞（${id}）不存在`;
        if (targetCave.status !== 'pending') return `回声洞（${id}）无需审核`;

        if (!action) {
          return this.buildReviewMessage(targetCave);
        }

        const normalizedAction = action.toLowerCase();
        if (APPROVE_ACTIONS.has(normalizedAction)) {
          return this.processReview('approve', targetCave, session.username);
        }
        if (REJECT_ACTIONS.has(normalizedAction)) {
          return this.processReview('reject', targetCave, session.username);
        }

        return `无效操作: "${action}"\n请使用 "Y" (通过) 或 "N" (拒绝)`;
      });
  }

  /**
   * 列出所有待审核的回声洞。
   * @private
   */
  private async listPendingCaves(): Promise<string> {
    const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' });
    if (pendingCaves.length === 0) {
      return '当前没有需要审核的回声洞';
    }
    const pendingIds = pendingCaves.map(c => c.id).join(', ');
    return `当前共有 ${pendingCaves.length} 条待审核回声洞，序号为：\n${pendingIds}`;
  }

  /**
   * 将一条新回声洞提交给管理员进行审核。
   * 如果没有配置管理员，将自动通过审核。
   * @param cave - 新创建的、状态为 'pending' 的回声洞对象。
   */
  public async sendForReview(cave: CaveObject): Promise<void> {
    if (!this.config.adminUsers?.length) {
      this.logger.warn(`No admin users configured. Cave ${cave.id} has been auto-approved.`);
      await this.ctx.database.upsert('cave', [{ id: cave.id, status: 'active' }]);
      return;
    }

    const reviewMessage = await this.buildReviewMessage(cave);
    try {
      await this.ctx.broadcast(this.config.adminUsers, reviewMessage);
    } catch (error) {
      this.logger.error(`Failed to broadcast review request for cave ${cave.id}:`, error);
    }
  }

  /**
   * 构建用于发送给管理员的审核消息。
   * @param cave - 待审核的回声洞对象。
   * @returns 一个可直接发送的消息数组。
   * @private
   */
  private async buildReviewMessage(cave: CaveObject): Promise<(string | h)[]> {
    const caveContent = await buildCaveMessage(cave, this.config, this.fileManager, this.logger);
    return [`待审核`, ...caveContent];
  }

  /**
   * 处理管理员的审核决定（通过或拒绝）。
   * @param action - 'approve' (通过) 或 'reject' (拒绝)。
   * @param cave - 被审核的回声洞对象。
   * @param adminUserName - 执行操作的管理员昵称。
   * @returns 返回给操作者的确认消息。
   */
  public async processReview(action: 'approve' | 'reject', cave: CaveObject, adminUserName: string): Promise<string | (string | h)[]> {
    let resultMessage: string;
    let broadcastMessage: string | (string | h)[];

    if (action === 'approve') {
      await this.ctx.database.upsert('cave', [{ id: cave.id, status: 'active' }]);
      resultMessage = `回声洞（${cave.id}）已通过`;
      broadcastMessage = `回声洞（${cave.id}）已由管理员 "${adminUserName}" 通过`;
    } else {
      await this.ctx.database.upsert('cave', [{ id: cave.id, status: 'delete' }]);
      resultMessage = `回声洞（${cave.id}）已拒绝`;
      const caveContent = await buildCaveMessage(cave, this.config, this.fileManager, this.logger);
      broadcastMessage = [ `回声洞（${cave.id}）已由管理员 "${adminUserName}" 拒绝`, ...caveContent ];

      // Clean up the rejected (deleted) cave in the background
      cleanupPendingDeletions(this.ctx, this.fileManager, this.logger).catch(err => {
        this.logger.error(`Background cleanup failed for rejected cave ${cave.id}:`, err);
      });
    }

    // 向其他管理员广播审核结果
    if (this.config.adminUsers?.length) {
      this.ctx.broadcast(this.config.adminUsers, broadcastMessage).catch(err => {
        this.logger.error(`Failed to broadcast review result for cave ${cave.id}:`, err);
      });
    }

    return resultMessage;
  }
}
