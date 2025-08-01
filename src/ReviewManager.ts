import { Context, h, Logger } from 'koishi';
import { CaveObject, Config } from './index';
import { FileManager } from './FileManager';
import { buildCaveMessage, cleanupPendingDeletions } from './Utils';

/**
 * 审核管理器 (ReviewManager)
 * @description
 * 负责处理回声洞的审核流程。当 `enableReview` 配置项开启时，
 * 此管理器将被激活，用于处理新回声洞的提交、向管理员发送审核通知
 * 以及处理管理员的审核操作（通过/拒绝）。
 */
export class ReviewManager {
  /**
   * 创建一个 ReviewManager 实例。
   * @param ctx - Koishi 上下文。
   * @param config - 插件配置。
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
   * @param cave - 主 `cave` 命令的实例，用于挂载子命令。
   */
  public registerCommands(cave) {
    cave.subcommand('.review [id:posint] [action:string]', '审核回声洞')
      .usage('查看或审核回声洞，使用 <Y/N> 进行审核。')
      .action(async ({ session }, id, action) => {
        // 权限检查
        if (!this.config.adminUsers.includes(session.userId)) {
          return '抱歉，你没有权限执行审核';
        }

        // --- 场景 1: 无参数，列出所有待审核的回声洞 ---
        if (!id) {
          const pendingCaves = await this.ctx.database.get('cave', { status: 'pending' });
          if (pendingCaves.length === 0) {
            return '当前没有需要审核的回声洞';
          }
          const pendingIds = pendingCaves.map(c => c.id).join(', ');
          return `当前共有 ${pendingCaves.length} 条待审核回声洞，序号为：\n${pendingIds}`;
        }

        // --- 场景 2 & 3 的前置检查 ---
        const [targetCave] = await this.ctx.database.get('cave', { id });
        if (!targetCave) {
          return `回声洞（${id}）不存在`;
        }
        if (targetCave.status !== 'pending') {
          return `回声洞（${id}）无需审核`;
        }

        // --- 场景 2: 只有 ID，没有操作，则显示该待审回声洞的详细内容 ---
        if (id && !action) {
          return this.buildReviewMessage(targetCave);
        }

        // --- 场景 3: 有 ID 和操作，处理审核 ---
        const normalizedAction = action.toLowerCase();
        let reviewAction: 'approve' | 'reject';

        if (['y', 'yes', 'ok', 'pass', 'approve'].includes(normalizedAction)) {
          reviewAction = 'approve';
        } else if (['n', 'no', 'deny', 'reject'].includes(normalizedAction)) {
          reviewAction = 'reject';
        } else {
          return `无效操作: "${action}"\n请使用 "Y" (通过) 或 "N" (拒绝)`;
        }

        // 调用核心处理函数，并返回结果给执行操作的管理员。
        return this.processReview(reviewAction, id, session.username);
      });
  }

  /**
   * 将一条新的回声洞提交给所有管理员进行审核。
   * @param cave - 新创建的、状态为 'pending' 的回声洞对象。
   */
  public async sendForReview(cave: CaveObject): Promise<void> {
    // 如果没有配置管理员，则自动通过审核，避免内容被卡住。
    if (!this.config.adminUsers?.length) {
      this.logger.warn(`未配置管理员，回声洞（${cave.id}）已自动通过审核`);
      await this.ctx.database.upsert('cave', [{ id: cave.id, status: 'active' }]);
      return;
    }

    // 构建审核消息。
    const reviewMessage = await this.buildReviewMessage(cave);
    try {
      // 向所有配置的管理员广播审核请求。
      await this.ctx.broadcast(this.config.adminUsers, reviewMessage);
    } catch (error) {
      this.logger.error(`广播回声洞（${cave.id}）审核请求失败:`, error);
    }
  }

  /**
   * 构建一条用于发送给管理员的、包含审核信息的消息。
   * @param cave - 待审核的回声洞对象。
   * @returns 一个可直接发送的消息数组。
   * @private
   */
  private async buildReviewMessage(cave: CaveObject): Promise<(string | h)[]> {
    // 复用 Utils中的 buildCaveMessage 来生成回声洞内容部分。
    const caveContent = await buildCaveMessage(cave, this.config, this.fileManager, this.logger);

    // 在内容上包裹审核提示信息。
    return [
      `以下内容待审核：`,
      ...caveContent,
    ];
  }

  /**
   * 处理管理员的审核决定（通过或拒绝）。
   * @param action - 'approve' (通过) 或 'reject' (拒绝)。
   * @param caveId - 被审核的回声洞 ID。
   * @param adminUserName - 执行操作的管理员的昵称。
   * @returns 返回给操作者的确认消息。
   */
  public async processReview(action: 'approve' | 'reject', caveId: number, adminUserName: string): Promise<string | (string | h)[]> {
    const [cave] = await this.ctx.database.get('cave', { id: caveId });

    if (!cave) return `回声洞（${caveId}）不存在`;
    if (cave.status !== 'pending') return `回声洞（${caveId}）无需审核`;

    let resultMessage: string | (string | h)[];
    let broadcastMessage: string | (string | h)[]; // 发送给其他管理员的通知消息。

    if (action === 'approve') {
      // 通过审核：将状态更新为 'active'。
      await this.ctx.database.upsert('cave', [{ id: caveId, status: 'active' }]);
      resultMessage = `回声洞（${caveId}）已通过`;
      broadcastMessage = `回声洞（${caveId}）已由管理员 "${adminUserName}" 通过`;
    } else { // 'reject'
      // 拒绝审核：将状态标记为 'delete'。
      await this.ctx.database.upsert('cave', [{ id: caveId, status: 'delete' }]);

      // 在触发后台清理前，先构建好包含内容的消息，以防文件被提前删除。
      const caveContent = await buildCaveMessage(cave, this.config, this.fileManager, this.logger);

      // 准备要返回给操作者和广播给其他管理员的消息。
      resultMessage = [
        `回声洞（${caveId}）已拒绝`,
        ...caveContent,
      ];
      broadcastMessage = [
        `回声洞（${caveId}）已由管理员 "${adminUserName}" 拒绝`,
        ...caveContent
      ];

      // 异步触发一次清理，此操作不会阻塞后续代码。
      cleanupPendingDeletions(this.ctx, this.fileManager, this.logger);
    }

    // 向其他管理员广播审核结果。
    if (broadcastMessage && this.config.adminUsers?.length) {
      await this.ctx.broadcast(this.config.adminUsers, broadcastMessage).catch(err => {
        this.logger.error(`广播回声洞（${cave.id}）审核结果失败:`, err);
      });
    }

    return resultMessage;
  }
}
