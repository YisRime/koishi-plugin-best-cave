import { Context } from 'koishi'

/**
 * @description 数据库 `cave_user` 表的结构定义。
 * @property userId 用户唯一ID，作为主键。
 * @property nickname 用户自定义的昵称。
 */
export interface UserProfile {
  userId: string;
  nickname: string;
}

// 扩展 Koishi 的 Tables 接口，以便 `ctx.database` 能正确提示 `cave_user` 表类型。
declare module 'koishi' {
  interface Tables {
    cave_user: UserProfile;
  }
}

/**
 * @class ProfileManager
 * @description
 * 负责管理用户在回声洞中的自定义昵称。
 * 当插件配置 `enableProfile` 为 true 时实例化。
 */
export class ProfileManager {

  /**
   * @constructor
   * @param ctx - Koishi 上下文，用于初始化数据库模型。
   */
  constructor(private ctx: Context) {
    // 扩展 `cave_user` 表模型，定义其结构和主键。
    this.ctx.model.extend('cave_user', {
      userId: 'string',   // 用户 ID
      nickname: 'string', // 用户自定义昵称
    }, {
      primary: 'userId', // 保证每个用户只有一条昵称记录。
    });
  }

  /**
   * @description 注册 `.profile` 子命令，用于管理用户昵称。
   * @param cave - 主 `cave` 命令实例。
   */
  public registerCommands(cave) {
    cave.subcommand('.profile [nickname:text]', '设置显示昵称')
      .usage('设置你在回声洞中显示的昵称。若不提供昵称，则清除现有昵称。')
      .action(async ({ session }, nickname) => {
        const trimmedNickname = nickname?.trim();

        if (trimmedNickname) {
          await this.setNickname(session.userId, trimmedNickname);
          return `昵称已更新为：${trimmedNickname}`;
        } else {
          await this.clearNickname(session.userId);
          return '昵称已清除';
        }
      });
  }

  /**
   * @description 设置或更新指定用户的昵称。
   * @param userId - 目标用户的 ID。
   * @param nickname - 要设置的新昵称。
   */
  public async setNickname(userId: string, nickname: string): Promise<void> {
    // 使用 `upsert` 方法，如果记录已存在则更新，不存在则插入。
    await this.ctx.database.upsert('cave_user', [{ userId, nickname }]);
  }

  /**
   * @description 获取指定用户的昵称。
   * @param userId - 目标用户的 ID。
   * @returns 返回用户的昵称字符串，如果未设置则返回 null。
   */
  public async getNickname(userId: string): Promise<string | null> {
    // 直接查询并返回结果，代码更简洁。
    const profile = await this.ctx.database.get('cave_user', { userId });
    return profile[0]?.nickname ?? null;
  }

  /**
   * @description 清除指定用户的昵称设置。
   * @param userId - 目标用户的 ID。
   */
  public async clearNickname(userId: string): Promise<void> {
    // 从数据库中删除指定用户的记录。
    await this.ctx.database.remove('cave_user', { userId });
  }
}
