import { Context, h, Logger } from 'koishi';
import { CaveObject, Config } from './index';
import { FileManager } from './FileManager';
import { buildCaveMessage, cleanupPendingDeletions } from './Utils';

/**
 * @class ReviewManager
 * @description
 * 负责处理回声洞的审核流程。当 `enableReview` 配置开启时，
 * 此管理器将被激活，处理新洞的提交、审核通知和审核操作。
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
        if (!this.config.adminUsers.includes(session.userId)) return '抱歉，你没有权限执行审核';

        // 场景1: 无参数，列出所有待审核
        if (!id) {
          const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' });
          if (pendingCaves.length === 0) return '当前没有需要审核的回声洞';
          return `当前共有 ${pendingCaves.length} 条待审核回声洞，序号为：\n${pendingCaves.map(c => c.id).join(', ')}`;
        }

        const [targetCave] = await this.ctx.database.get('cave', { id });
        if (!targetCave) return `回声洞（${id}）不存在`;
        if (targetCave.status !== 'pending') return `回声洞（${id}）无需审核`;

        // 场景2: 只有ID，显示待审内容
        if (id && !action) {
          return [`待审核：`, ...await buildCaveMessage(targetCave, this.config, this.fileManager, this.logger)];
        }

        // 场景3: 有ID和操作，处理审核
        const normalizedAction = action.toLowerCase();
        let reviewAction: 'approve' | 'reject';
        if (['y', 'yes', 'ok', 'pass', 'approve'].includes(normalizedAction)) reviewAction = 'approve';
        else if (['n', 'no', 'deny', 'reject'].includes(normalizedAction)) reviewAction = 'reject';
        else return `无效操作: "${action}"\n请使用 "Y" (通过) 或 "N" (拒绝)`;

        return this.processReview(reviewAction, id, session.username);
      });
  }

  /**
   * @description 将新回声洞提交给管理员审核。
   * @param cave 新创建的、状态为 'pending' 的回声洞对象。
   */
  public async sendForReview(cave: CaveObject): Promise<void> {
    if (!this.config.adminUsers?.length) {
      this.logger.warn(`未配置管理员，回声洞（${cave.id}）已自动通过审核`);
      await this.ctx.database.upsert('cave', [{ id: cave.id, status: 'active' }]);
      return;
    }

    // 构建审核消息
    const reviewMessage = [`待审核：`, ...await buildCaveMessage(cave, this.config, this.fileManager, this.logger)];
    try {
      await this.ctx.broadcast(this.config.adminUsers, reviewMessage);
    } catch (error) {
      this.logger.error(`广播回声洞（${cave.id}）审核请求失败:`, error);
    }
  }

  /**
   * @description 处理管理员的审核决定（通过或拒绝）。
   * @param action 'approve' (通过) 或 'reject' (拒绝)。
   * @param caveId 被审核的回声洞 ID。
   * @param adminUserName 操作管理员的昵称。
   * @returns 返回给操作者的确认消息。
   */
  public async processReview(action: 'approve' | 'reject', caveId: number, adminUserName: string): Promise<string | (string | h)[]> {
    const [cave] = await this.ctx.database.get('cave', { id: caveId, status: 'pending' });
    if (!cave) return `回声洞（${caveId}）不存在或无需审核`;

    let resultMessage: string | (string | h)[];
    let broadcastMessage: string | (string | h)[];

    if (action === 'approve') {
      // 通过审核：更新状态为 'active'
      await this.ctx.database.upsert('cave', [{ id: caveId, status: 'active' }]);
      resultMessage = `回声洞（${caveId}）已通过`;
      broadcastMessage = `回声洞（${caveId}）已由管理员 "${adminUserName}" 通过`;
    } else { // 'reject'
      // 拒绝审核：标记为 'delete'
      await this.ctx.database.upsert('cave', [{ id: caveId, status: 'delete' }]);
      resultMessage = `回声洞（${caveId}）已拒绝`;
      broadcastMessage = `回声洞（${caveId}）已由管理员 "${adminUserName}" 拒绝`;
      // 异步触发清理，不阻塞当前响应
      cleanupPendingDeletions(this.ctx, this.fileManager, this.logger);
    }

    // 向其他管理员广播审核结果
    if (this.config.adminUsers?.length) {
      this.ctx.broadcast(this.config.adminUsers, broadcastMessage).catch(err => {
        this.logger.error(`广播回声洞（${cave.id}）审核结果失败:`, err);
      });
    }

    return resultMessage;
  }
}
