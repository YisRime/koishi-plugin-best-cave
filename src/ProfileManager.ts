import { Context } from 'koishi'

/**
 * 数据库中 `cave_user` 表的记录结构。
 * @property userId - 用户的唯一 ID，作为主键。
 * @property nickname - 用户设置的自定义昵称。
 */
export interface UserProfile {
  userId: string;
  nickname: string;
}

// 扩展 Koishi 的 Tables 接口，以便在 `ctx.database` 中获得 `cave_user` 表的类型提示。
declare module 'koishi' {
  interface Tables {
    cave_user: UserProfile;
  }
}

/**
 * 个人资料管理器 (ProfileManager)
 * @description
 * 负责管理用户在回声洞插件中的自定义昵称。
 * 提供设置、获取和清除昵称的数据库操作和相关命令。
 * 此类仅在插件配置中启用了 `enableProfile` 时才会被实例化。
 */
export class ProfileManager {

  /**
   * 创建一个 ProfileManager 实例。
   * @param ctx - Koishi 上下文，用于初始化数据库模型。
   */
  constructor(private ctx: Context) {
    // 扩展数据库模型，定义 `cave_user` 表的结构和主键。
    this.ctx.model.extend('cave_user', {
      userId: 'string',   // 用户 ID
      nickname: 'string', // 用户自定义昵称
    }, {
      primary: 'userId', // 使用 userId 作为主键，确保每个用户只有一条昵称记录。
    });
  }

  /**
   * 注册与用户昵称相关的 `.profile` 子命令。
   * @param cave - 主 `cave` 命令的实例，用于挂载子命令。
   */
  public registerCommands(cave) {
    cave.subcommand('.profile [nickname:text]', '设置显示昵称')
      .usage('设置你在回声洞中显示的昵称。不提供昵称则清除记录。')
      .action(async ({ session }, nickname) => {
        // trim() 用于去除昵称前后的空格。
        const trimmedNickname = nickname?.trim();
        // 如果没有提供昵称，则视为清除操作。
        if (!trimmedNickname) {
          await this.clearNickname(session.userId);
          return '昵称已清除';
        }
        // 否则，设置新昵称。
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
    // 使用 `upsert` (update or insert) 方法。
    // 如果该用户的记录已存在，则更新 nickname 字段；如果不存在，则插入一条新记录。
    await this.ctx.database.upsert('cave_user', [{
      userId,
      nickname,
    }]);
  }

  /**
   * 获取指定用户的昵称。
   * @param userId - 目标用户的 ID。
   * @returns 返回用户的昵称字符串。如果用户未设置昵称，则返回 null。
   */
  public async getNickname(userId: string): Promise<string | null> {
    // `ctx.database.get()` 方法返回一个符合查询条件的对象数组。
    const profiles = await this.ctx.database.get('cave_user', { userId });
    // 如果找到了记录（数组非空），则返回第一个元素的 nickname 属性，否则返回 null。
    return profiles[0]?.nickname || null;
  }

  /**
   * 清除指定用户的昵称设置。
   * @param userId - 目标用户的 ID。
   */
  public async clearNickname(userId: string): Promise<void> {
    // 从数据库中删除符合条件（即指定 userId）的记录。
    await this.ctx.database.remove('cave_user', { userId });
  }
}
