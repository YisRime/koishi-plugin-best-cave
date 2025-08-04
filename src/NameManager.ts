import { Context } from 'koishi'

/** 数据库 `cave_user` 表的结构。 */
export interface UserName {
  userId: string;
  nickname: string;
}

declare module 'koishi' {
  interface Tables {
    cave_user: UserName;
  }
}

/**
 * @class NameManager
 * @description 负责管理用户在回声洞中的自定义昵称。
 */
export class NameManager {
  /**
   * @constructor
   * @param ctx - Koishi 上下文，用于初始化数据库模型。
   */
  constructor(private ctx: Context) {
    this.ctx.model.extend('cave_user', {
      userId: 'string',
      nickname: 'string',
    }, {
      primary: 'userId',
    });
  }

  /**
   * @description 注册 `.name` 子命令，用于管理用户昵称。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    cave.subcommand('.name [nickname:text]', '设置显示昵称')
      .usage('设置在回声洞中显示的昵称。若不提供昵称，则清除现有昵称。')
      .action(async ({ session }, nickname) => {
        const trimmedNickname = nickname?.trim();
        if (trimmedNickname) {
          await this.setNickname(session.userId, trimmedNickname);
          return `昵称已更新为：${trimmedNickname}`;
        }
        await this.clearNickname(session.userId);
        return '昵称已清除';
      });
  }

  /**
   * @description 设置或更新指定用户的昵称。
   * @param userId - 目标用户的 ID。
   * @param nickname - 要设置的新昵称。
   */
  public async setNickname(userId: string, nickname: string): Promise<void> {
    await this.ctx.database.upsert('cave_user', [{ userId, nickname }]);
  }

  /**
   * @description 获取指定用户的昵称。
   * @param userId - 目标用户的 ID。
   * @returns 用户的昵称字符串或 null。
   */
  public async getNickname(userId: string): Promise<string | null> {
    const [name] = await this.ctx.database.get('cave_user', { userId });
    return name?.nickname ?? null;
  }

  /**
   * @description 清除指定用户的昵称设置。
   * @param userId - 目标用户的 ID。
   */
  public async clearNickname(userId: string): Promise<void> {
    await this.ctx.database.remove('cave_user', { userId });
  }
}
