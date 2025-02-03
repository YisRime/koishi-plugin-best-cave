// 导入核心依赖
import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';

// 日志记录器
const logger = new Logger('cave');

// 基础定义
export const name = 'cave';
export const inject = ['database'];

// 接口定义
export interface User {
  userId: string;
  username: string;
  nickname?: string;
}

export interface getStrangerInfo {
  user_id: string;
  nickname: string;
}

export interface Config {
  manager: string[];
  number: number;
  enableAudit: boolean;
}

// 定义数据类型接口
interface Element {
  type: 'text' | 'img';  // 元素类型：文本或图片
  content?: string;      // 文本内容
  file?: string;         // 图片文件名
  index: number;         // 排序索引
}

// 定义回声洞数据结构
interface CaveObject {
  cave_id: number;             // 回声洞唯一ID
  elements: Element[];         // 内容元素数组
  contributor_number: string;  // 投稿者ID
  contributor_name: string;    // 投稿者昵称
}

interface PendingCave extends CaveObject {}

// 配置Schema
export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员账号'),
  number: Schema.number().default(60).description('群内调用冷却时间（秒）'),
  enableAudit: Schema.boolean().default(false).description('是否开启审核功能'),
});

// 整合文件操作相关函数
function readJsonData<T>(filePath: string, validator?: (item: any) => boolean): T[] {
  try {
    // 读取并解析JSON文件
    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data || '[]');

    // 验证数据结构
    if (!Array.isArray(parsed)) return [];
    return validator ? parsed.filter(validator) : parsed;
  } catch (error) {
    logger.error(`读取文件失败 ${filePath}: ${error.message}`);
    return [];
  }
}

function writeJsonData<T>(filePath: string, data: T[]): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    logger.error(`写入文件失败: ${error.message}`);
    throw error;
  }
}

// 文件操作工具
async function ensureDirectory(dir: string): Promise<void> {
  try {
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  } catch (error) {
    logger.error(`创建目录失败 ${dir}: ${error.message}`);
    throw error;
  }
}

async function ensureJsonFile(filePath: string, defaultContent = '[]'): Promise<void> {
  try {
    if (!fs.existsSync(filePath)) {
      await fs.promises.writeFile(filePath, defaultContent, 'utf8');
    }
  } catch (error) {
    logger.error(`创建文件失败 ${filePath}: ${error.message}`);
    throw error;
  }
}

// 图片处理函数：支持批量保存
async function saveImages(
  urls: string[],         // 图片URL数组
  imageDir: string,       // 保存目录
  caveId: number,        // 回声洞ID
  config: Config,        // 插件配置
  ctx: Context          // 应用上下文
): Promise<string[]> {
  const savedFiles: string[] = [];

  // 遍历处理每个图片URL
  for (let i = 0; i < urls.length; i++) {
    try {
      // 处理URL编码问题
      const url = urls[i];
      const processedUrl = (() => {
        try {
          const decodedUrl = decodeURIComponent(url);
          if (decodedUrl.includes('multimedia.nt.qq.com.cn')) {
            return decodedUrl.replace(/&amp;/g, '&');
          }
          return url;
        } catch {
          return url;
        }
      })();

      // 生成文件名和路径
      const ext = url.match(/\.([^./?]+)(?:[?#]|$)/)?.[1] || 'png';
      const filename = `${caveId}_${i + 1}.${ext}`;
      const targetPath = path.join(imageDir, filename);

      // 下载并保存图片
      const buffer = await ctx.http.get<ArrayBuffer>(processedUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'image/*',
          'Referer': 'https://qq.com'
        }
      });

      // 写入文件系统
      if (buffer && buffer.byteLength > 0) {
        await fs.promises.writeFile(targetPath, Buffer.from(buffer));
        savedFiles.push(filename);
      }
    } catch (error) {
      logger.error(`保存图片失败: ${error.message}`);
    }
  }

  return savedFiles;
}

// 审核处理
async function sendAuditMessage(ctx: Context, config: Config, cave: PendingCave, content: string) {
  const auditMessage = `待审核回声洞：\n${content}
来自：${cave.contributor_number}`;
  for (const managerId of config.manager) {
    try {
      await ctx.bots[0]?.sendPrivateMessage(managerId, auditMessage);
    } catch (error) {
      logger.error(`发送审核消息 ${managerId} 失败: ${error.message}`);
    }
  }
}

// 审核相关函数
async function handleSingleCaveAudit(
  ctx: Context,
  cave: PendingCave,
  isApprove: boolean,
  imageDir: string,
  data?: CaveObject[]
): Promise<boolean> {
  try {
    if (isApprove && data) {
      const caveWithoutIndex = {
        ...cave,
        elements: cleanElementsForSave(cave.elements, false)
      };
      data.push(caveWithoutIndex);
      logger.info(`审核通过回声洞（${cave.cave_id}）`);
    } else if (!isApprove && cave.elements) {
      for (const element of cave.elements) {
        if (element.type === 'img' && element.file) {
          const fullPath = path.join(imageDir, element.file);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
      logger.info(`审核失败回声洞（${cave.cave_id}）`);
    }
    return true;
  } catch (error) {
    logger.error(`处理回声洞（${cave.cave_id}）失败: ${error.message}`);
    return false;
  }
}

async function handleAudit(
  ctx: Context,
  pendingData: PendingCave[],
  isApprove: boolean,
  caveFilePath: string,
  imageDir: string,
  pendingFilePath: string,
  targetId?: number
): Promise<string> {
  if (pendingData.length === 0) return '没有待审核回声洞';

  // 处理单条审核
  if (typeof targetId === 'number') {
    const pendingIndex = pendingData.findIndex(item => item.cave_id === targetId);
    if (pendingIndex === -1) return '未找到该待审核回声洞';

    const cave = pendingData[pendingIndex];
    const data = isApprove ? readJsonData<CaveObject>(caveFilePath) : null;

    const success = await handleSingleCaveAudit(ctx, cave, isApprove, imageDir, data);
    if (!success) return '处理失败，请稍后重试';

    if (isApprove && data) writeJsonData(caveFilePath, data);
    pendingData.splice(pendingIndex, 1);
    writeJsonData(pendingFilePath, pendingData);

    const remainingCount = pendingData.length;
    if (remainingCount > 0) {
      const remainingIds = pendingData.map(c => c.cave_id).join(', ');
      return `${isApprove ? '审核通过' : '拒绝'}成功，还有 ${remainingCount} 条待审核：[${remainingIds}]`;
    }
    return isApprove ? '已通过该回声洞' : '已拒绝该回声洞';
  }

  // 处理批量审核
  const data = isApprove ? readJsonData<CaveObject>(caveFilePath) : null;
  let processedCount = 0;

  for (const cave of pendingData) {
    const success = await handleSingleCaveAudit(ctx, cave, isApprove, imageDir, data);
    if (success) processedCount++;
  }

  if (isApprove && data) writeJsonData(caveFilePath, data);
  writeJsonData(pendingFilePath, []);

  return isApprove ?
    `✅ 已通过 ${processedCount}/${pendingData.length} 条回声洞` :
    `❌ 已拒绝 ${processedCount}/${pendingData.length} 条回声洞`;
}

// 消息构建函数：合成最终展示内容
function buildMessage(cave: CaveObject, imageDir: string): string {
  // 构建标题
  let content = `回声洞 ——（${cave.cave_id}）\n`;

  // 遍历处理每个元素
  for (const element of cave.elements) {
    if (element.type === 'text') {
      // 添加文本内容
      content += element.content + '\n';
    } else if (element.type === 'img' && element.file) {
      try {
        // 处理图片内容
        const fullImagePath = path.join(imageDir, element.file);
        if (fs.existsSync(fullImagePath)) {
          const imageBuffer = fs.readFileSync(fullImagePath);
          const base64Image = imageBuffer.toString('base64');
          content += h('image', { src: `data:image/png;base64,${base64Image}` }) + '\n';
        }
      } catch (error) {
        logger.error(`读取图片失败: ${error.message}`);
      }
    }
  }

  // 添加署名
  return content + `—— ${cave.contributor_name}`;
}

// 在文件顶部添加清理函数
function cleanElementsForSave(elements: Element[], keepIndex: boolean = false): Element[] {
  const sorted = elements.sort((a, b) => a.index - b.index);
  return sorted.map(({ type, content, file, index }) => ({
    type,
    ...(keepIndex && { index }),
    ...(content && { content }),
    ...(file && { file })
  }));
}

// 插件主函数：初始化和命令注册
export async function apply(ctx: Context, config: Config) {
  // 初始化配置
  const dataDir = path.join(ctx.baseDir, 'data');
  const caveDir = path.join(dataDir, 'cave');
  const caveFilePath = path.join(caveDir, 'cave.json');
  const imageDir = path.join(caveDir, 'images');
  const pendingFilePath = path.join(caveDir, 'pending.json');

  try {
    // 确保所有必要的目录存在
    await ensureDirectory(dataDir);
    await ensureDirectory(caveDir);
    await ensureDirectory(imageDir);

    // 确保数据文件存在
    await ensureJsonFile(caveFilePath);
    await ensureJsonFile(pendingFilePath);
  } catch (error) {
    logger.error('初始化目录结构失败:', error);
    throw error;
  }

  // 群组冷却时间管理
  const lastUsed: Map<string, number> = new Map();

  // 命令处理主函数
  ctx.command('cave', '回声洞')
    .usage('支持添加、抽取、查看、查询回声洞')
    .example('cave           随机抽取回声洞')
    .example('cave -a 内容   添加新回声洞')
    .example('cave -g/r x      查看/删除指定回声洞')
    .example('cave -p/d x/all  通过/拒绝待审回声洞')
    .example('cave -l x      查询投稿者投稿列表')
    .option('a', '添加回声洞')
    .option('g', '查看回声洞', { type: 'string' })
    .option('r', '删除回声洞', { type: 'string' })
    .option('p', '通过审核', { type: 'string' })
    .option('d', '拒绝审核', { type: 'string' })
    .option('l', '查询投稿统计', { type: 'string' })
    // 仅对 -l、-p 和 -d 指令进行权限检查
    .before(async ({ session, options }) => {
      if ((options.l || options.p || options.d) && !config.manager.includes(session.userId)) {
        return '只有管理员才能执行此操作';
      }
    })
    .action(async ({ session, options }, ...content) => {
      if (options.l !== undefined) {
        // 获取统计数据
        const caveFilePath = path.join(ctx.baseDir, 'data', 'cave', 'cave.json');
        const caveDir = path.join(ctx.baseDir, 'data', 'cave');
        const caveData = readJsonData<CaveObject>(caveFilePath);
        const stats: Record<string, number[]> = {};
        for (const cave of caveData) {
          if (cave.contributor_number === '10000') continue;
          if (!stats[cave.contributor_number]) stats[cave.contributor_number] = [];
          stats[cave.contributor_number].push(cave.cave_id);
        }

        // 保存统计文件
        const statFilePath = path.join(caveDir, 'stat.json');
        try {
          fs.writeFileSync(statFilePath, JSON.stringify(stats, null, 2), 'utf8');
        } catch (error) {
          logger.error(`写入投稿统计失败: ${error.message}`);
        }

        // 格式化函数
        function formatIds(ids: number[]): string {
          const lines: string[] = [];
          for (let i = 0; i < ids.length; i += 10) {
            lines.push(ids.slice(i, i + 10).join(', '));
          }
          return lines.join('\n');
        }

        // 获取查询参数
        let queryId: string | null = null;

        // 优先检查 options.l 是否为数字字符串
        if (typeof options.l === 'string') {
          const match = String(options.l).match(/\d+/);
          if (match) queryId = match[0];
        }
        // 如果 options.l 不是数字，检查 content 中是否包含数字
        else if (!queryId && content.length > 0) {
          const numberMatch = content.join(' ').match(/\d+/);
          if (numberMatch) {
            queryId = numberMatch[0];
          }
        }

        if (queryId) {
          // 查询指定投稿者
          if (stats[queryId]) {
            const count = stats[queryId].length;
            return `${queryId} 共计投稿 ${count} 项回声洞:\n` + formatIds(stats[queryId]);
          } else {
            return `未找到投稿者 ${queryId}`;
          }
        } else {
          // 查询所有
          let total = 0;
          const lines = Object.entries(stats).map(([cid, ids]) => {
            total += ids.length;
            return `${cid} 共计投稿 ${ids.length} 项回声洞:\n` + formatIds(ids);
          });
          return `共计投稿 ${total} 项回声洞:\n` + lines.join('\n');
        }
      }
      try {
        // 处理审核相关操作
        if (options.p || options.d) {
          const pendingData = readJsonData<PendingCave>(pendingFilePath);
          const isApprove = Boolean(options.p);

          // 修改批量审核判断逻辑
          if ((options.p === true && content[0] === 'all') ||
              (options.d === true && content[0] === 'all')) {
            return await handleAudit(ctx, pendingData, isApprove, caveFilePath, imageDir, pendingFilePath);
          }

          // 单条审核
          const id = parseInt(content[0] ||
            (typeof options.p === 'string' ? options.p : '') ||
            (typeof options.d === 'string' ? options.d : ''));

          if (isNaN(id)) return '请输入正确的回声洞序号';

          return await handleAudit(ctx, pendingData, isApprove, caveFilePath, imageDir, pendingFilePath, id);
        }

        // 数据合法性验证
        const data = readJsonData<CaveObject>(caveFilePath, item =>
          item &&
          typeof item.cave_id === 'number' &&
          Array.isArray(item.elements) &&
          item.elements.every(el =>
            (el.type === 'text' && typeof el.content === 'string') ||
            (el.type === 'img' && typeof el.file === 'string')
          ) &&
          typeof item.contributor_number === 'string' &&
          typeof item.contributor_name === 'string'
        );

        // 处理添加操作
        if (options.a) {
          // 提取原始内容
          const originalContent = session.quote?.content || session.content;
          const elements: Element[] = [];
          const imageUrls: string[] = [];

          // 处理文本内容：同时支持 prefix 和 nickname
          const prefixes = Array.isArray(session.app.config.prefix)
            ? session.app.config.prefix
            : [session.app.config.prefix];

          const nicknames = Array.isArray(session.app.config.nickname)
            ? session.app.config.nickname
            : session.app.config.nickname ? [session.app.config.nickname] : [];

          // 合并所有可能的触发前缀
          const allTriggers = [...prefixes, ...nicknames];

          const triggerPattern = allTriggers
            .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|');

          const commandPattern = new RegExp(`^(?:${triggerPattern})?\\s*cave -a\\s*`);

          const textParts = originalContent
            .replace(commandPattern, '')
            .split(/<img[^>]+>/g)
            .map(text => text.trim())
            .filter(text => text)
            .map((text, idx) => ({
              type: 'text' as const,
              content: text,
              index: idx * 2  // 文本使用偶数索引
            }));

          // 处理图片内容
          const imgMatches = originalContent.match(/<img[^>]+src="([^"]+)"[^>]*>/g) || [];
          const imageElements = imgMatches.map((img, idx) => {
            const match = img.match(/src="([^"]+)"/);
            if (match?.[1]) {
              imageUrls.push(match[1]);
              return {
                type: 'img' as const,
                index: idx * 2 + 1  // 图片使用奇数索引
              };
            }
            return null;
          }).filter((el): el is NonNullable<typeof el> => el !== null);

          // 生成新的回声洞ID
          const pendingData = readJsonData<PendingCave>(pendingFilePath);
          const maxDataId = data.length > 0 ? Math.max(...data.map(item => item.cave_id)) : 0;
          const maxPendingId = pendingData.length > 0 ? Math.max(...pendingData.map(item => item.cave_id)) : 0;
          const caveId = Math.max(maxDataId, maxPendingId) + 1;

          // 保存图片文件
          let savedImages: string[] = [];
          if (imageUrls.length > 0) {
            try {
              savedImages = await saveImages(imageUrls, imageDir, caveId, config, ctx);
            } catch (error) {
              logger.error(`保存图片失败: ${error.message}`);
            }
          }

          // 合并所有元素
          elements.push(...textParts);

          savedImages.forEach((file, idx) => {
            if (imageElements[idx]) {
              elements.push({
                ...imageElements[idx],
                type: 'img',
                file
              });
            }
          });

          // 按索引排序
          elements.sort((a, b) => a.index - b.index);

          if (elements.length === 0) {
            return '添加失败：无内容，请尝试重新发送';
          }

          // 获取投稿者信息
          let contributorName = session.username;
          if (ctx.database) {
            try {
              const userInfo = await ctx.database.getUser(session.platform, session.userId);
              contributorName = (userInfo as unknown as User)?.nickname || session.username;
            } catch (error) {
              logger.error(`获取用户昵称失败: ${error.message}`);
            }
          }

          // 创建新的回声洞对象
          const newCave: CaveObject = {
            cave_id: caveId,
            elements: cleanElementsForSave(elements, true),
            contributor_number: session.userId,
            contributor_name: contributorName
          };

          // 处理审核流程
          if (config.enableAudit) {
            pendingData.push({
              ...newCave,
              elements: cleanElementsForSave(elements, true)
            });
            writeJsonData(pendingFilePath, pendingData);
            await sendAuditMessage(ctx, config, newCave, buildMessage(newCave, imageDir));
            return `✨ 已提交审核，序号为 (${caveId})`;
          }

          // 直接保存内容
          const caveWithoutIndex = {
            ...newCave,
            elements: cleanElementsForSave(elements, false)
          };
          data.push(caveWithoutIndex);
          writeJsonData(caveFilePath, data);
          return `✨ 添加成功！序号为 (${caveId})`;
        }

        // 处理查看操作
        if (options.g) {
          const caveId = parseInt(content[0] || (typeof options.g === 'string' ? options.g : ''));
          if (isNaN(caveId)) {
            return '请输入正确的回声洞序号';
          }

          const cave = data.find(item => item.cave_id === caveId);
          if (!cave) {
            return '未找到该序号的回声洞';
          }

          return buildMessage(cave, imageDir);
        }

        // 处理随机抽取
        if (!options.a && !options.g && !options.r) {
          if (data.length === 0) return '暂无回声洞可用';

          // 处理冷却时间
          const guildId = session.guildId;
          const now = Date.now();
          const lastCall = lastUsed.get(guildId) || 0;

          // 检查是否为管理员
          const isManager = config.manager.includes(session.userId);

          if (!isManager && now - lastCall < config.number * 1000) {
            const waitTime = Math.ceil((config.number * 1000 - (now - lastCall)) / 1000);
            return `群聊冷却中...请${waitTime}秒后再试`;
          }

          // 更新最后使用时间
          if (!isManager) {
            lastUsed.set(guildId, now);
          }

          const cave = (() => {
            const validCaves = data.filter(cave => cave.elements && cave.elements.length > 0);
            if (!validCaves.length) return undefined;
            const randomIndex = Math.floor(Math.random() * validCaves.length);
            return validCaves[randomIndex];
          })();
          if (!cave) return '获取回声洞失败';

          return buildMessage(cave, imageDir);
        }

        // 处理删除操作
        if (options.r) {
          const caveId = parseInt(content[0] || (typeof options.r === 'string' ? options.r : ''));
          if (isNaN(caveId)) {
            return '请输入正确的回声洞序号';
          }

          // 检查回声洞
          const index = data.findIndex(item => item.cave_id === caveId);
          const pendingData = readJsonData<PendingCave>(pendingFilePath);
          const pendingIndex = pendingData.findIndex(item => item.cave_id === caveId);

          if (index === -1 && pendingIndex === -1) {
            return '未找到该序号的回声洞';
          }

          let targetCave: CaveObject;
          let isPending = false;

          if (index !== -1) {
            targetCave = data[index];
          } else {
            targetCave = pendingData[pendingIndex];
            isPending = true;
          }

          // 权限校验：检查是否为内容贡献者或管理员
          if (targetCave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
            return '你不是这条回声洞的添加者！';
          }

          // 删除相关图片文件
          if (targetCave.elements) {
            try {
              for (const element of targetCave.elements) {
                if (element.type === 'img' && element.file) {
                  const fullPath = path.join(imageDir, element.file);
                  if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                  }
                }
              }
            } catch (error) {
              logger.error(`删除图片失败: ${error.message}`);
            }
          }

          // 从相应的数组中删除
          if (isPending) {
            pendingData.splice(pendingIndex, 1);
            writeJsonData(pendingFilePath, pendingData);
            return `✅ 已删除待审核回声洞 （${caveId}）`;
          } else {
            data.splice(index, 1);
            writeJsonData(caveFilePath, data);
            return `✅ 已删除回声洞 （${caveId}）`;
          }
        }

      } catch (error) {
        // 错误日志记录
        logger.error(`操作失败: ${error.message}`);
        return '操作失败，请稍后重试';
      }
    });
}
