import { Context } from 'koishi';

/**
 * @interface UserProfile
 * @description 数据库中 `cave_user` 表的记录结构。
 * @property {string} userId - 用户的唯一 ID，作为主键。
 * @property {string} nickname - 用户在回声洞中显示的自定义昵称。
 */
export interface UserProfile {
  userId: string;
  nickname: string;
}

declare module 'koishi' {
  interface Tables {
    cave_user: UserProfile;
  }
}

/**
 * @class ProfileManager
 * @description 负责管理用户在回声洞插件中的自定义昵称。
 * 提供设置、获取和清除昵称的数据库操作和相关命令。
 */
export class ProfileManager {
  /**
   * @param ctx - Koishi 上下文，用于数据库交互。
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
   * 注册与用户昵称相关的 `.profile` 子命令。
   * @param cave - 主 `cave` 命令实例，用于挂载子命令。
   */
  public registerCommands(cave) {
    cave.subcommand('.profile [nickname:text]', '设置显示昵称')
      .usage('设置你在回声洞中显示的昵称。不提供昵称则清除记录。')
      .action(async ({ session }, nickname) => {
        const trimmedNickname = nickname?.trim();
        if (!trimmedNickname) {
          await this.clearNickname(session.userId);
          return '昵称已清除';
        }
        await this.setNickname(session.userId, trimmedNickname);
        return `昵称已更新为：${trimmedNickname}`;
      });
  }

  /**
   * 设置或更新指定用户的昵称。
   * @param userId - 目标用户的 ID。
   * @param nickname - 要设置的新昵称。
   */
  public async setNickname(userId: string, nickname: string): Promise<void> {
    await this.ctx.database.upsert('cave_user', [{ userId, nickname }]);
  }

  /**
   * 获取指定用户的昵称。
   * @param userId - 目标用户的 ID。
   * @returns 返回用户的昵称字符串，如果用户未设置则返回 null。
   */
  public async getNickname(userId: string): Promise<string | null> {
    const [profile] = await this.ctx.database.get('cave_user', { userId });
    return profile?.nickname || null;
  }

  /**
   * 清除指定用户的昵称设置。
   * @param userId - 目标用户的 ID。
   */
  public async clearNickname(userId: string): Promise<void> {
    await this.ctx.database.remove('cave_user', { userId });
  }
}
