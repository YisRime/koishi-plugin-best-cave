// -------- 导入依赖、接口定义与配置 --------
// 导入核心依赖
import { Context, Schema, h, Logger } from 'koishi'
import * as fs from 'fs';
import * as path from 'path';

// 基础定义
export const name = 'cave';
export const inject = ['database'];

// 配置Schema
export const Config: Schema<Config> = Schema.object({
  manager: Schema.array(Schema.string()).required().description('管理员'),
  blacklist: Schema.array(Schema.string()).default([]).description('黑名单'),
  number: Schema.number().default(60).description('调用冷却时间（秒）'),
  enableAudit: Schema.boolean().default(false).description('审核功能'),
  allowVideo: Schema.boolean().default(true).description('允许添加视频'),
  videoMaxSize: Schema.number().default(10).description('视频最大大小（MB）'),
  imageMaxSize: Schema.number().default(5).description('图片最大大小（MB）'),
});

// 插件主函数：初始化和命令注册
export async function apply(ctx: Context, config: Config) {
  // 初始化路径（caveFilePath, resourceDir, pendingFilePath）
  const { caveFilePath, resourceDir, pendingFilePath } = await initCavePaths(ctx);
  // 初始化群组冷却管理
  const lastUsed: Map<string, number> = new Map();

  // 注册命令并配置权限检查
  ctx.command('cave [message:text]', '回声洞')
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
      // 黑名单检查
      if (config.blacklist.includes(session.userId)) return '你已被列入黑名单';
      // 如果输入内容包含 "-help"，不进行权限检查
      if (session.content && session.content.includes('-help')) return;
      if ((options.l || options.p || options.d) && !config.manager.includes(session.userId)) {
        return '此操作仅管理员可用';
      }
    })
    .action(async ({ session, options }, ...content) => {
      // 调用主业务处理函数
      return await handleCaveAction(ctx, config, session, options, content, lastUsed);
    });
}

// 日志记录器
const logger = new Logger('cave');

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
  allowVideo: boolean;
  videoMaxSize: number;
  imageMaxSize: number;  // 新增属性
  blacklist: string[];  // 新增属性
}

// 定义数据类型接口
interface Element {
  type: 'text' | 'img' | 'video';
  content?: string;      // 文本内容
  file?: string;         // 图片或视频文件名
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

// -------- 新增：文件处理类 --------
class FileHandler {
	static readJsonData<T>(filePath: string, validator?: (item: any) => boolean): T[] {
		try {
			const data = fs.readFileSync(filePath, 'utf8');
			const parsed = JSON.parse(data || '[]');
			if (!Array.isArray(parsed)) return [];
			return validator ? parsed.filter(validator) : parsed;
		} catch (error) {
			throw new Error(`操作失败: ${error.message}`);
		}
	}

	static writeJsonData<T>(filePath: string, data: T[]): void {
		try {
			fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
		} catch (error) {
			throw new Error(`操作失败: ${error.message}`);
		}
	}

	static async ensureDirectory(dir: string): Promise<void> {
		try {
			if (!fs.existsSync(dir)) {
				await fs.promises.mkdir(dir, { recursive: true });
			}
		} catch (error) {
			throw new Error(`操作失败: ${error.message}`);
		}
	}

	static async ensureJsonFile(filePath: string, defaultContent = '[]'): Promise<void> {
		try {
			if (!fs.existsSync(filePath)) {
				await fs.promises.writeFile(filePath, defaultContent, 'utf8');
			}
		} catch (error) {
			throw new Error(`操作失败: ${error.message}`);
		}
	}
}

// -------- 图片及视频处理函数 --------
async function saveMedia(
  urls: string[],
  fileSuggestions: (string | undefined)[],
  resourceDir: string,
  caveId: number,
  config: Config,
  ctx: Context,
  mediaType: 'img' | 'video'
): Promise<string[]> {
  // 下载并保存媒体（图片/视频）
  const savedFiles: string[] = [];
  // 根据媒体类型设置默认扩展名、接受类型及大小限制
  const defaults = mediaType === 'img'
    ? { ext: 'png', accept: 'image/*', maxSize: config.imageMaxSize }
    : { ext: 'mp4', accept: 'video/*', maxSize: config.videoMaxSize };
  const extPattern = /\.[a-zA-Z0-9]+$/;
  for (let i = 0; i < urls.length; i++) {
    try {
      // 处理 URL 编码和特定域名替换
      const url = urls[i];
      const processedUrl = (() => {
        try {
          const decodedUrl = decodeURIComponent(url);
          return decodedUrl.includes('multimedia.nt.qq.com.cn') ? decodedUrl.replace(/&amp;/g, '&') : url;
        } catch {
          return url;
        }
      })();
      let ext = defaults.ext;
      const suggestion = fileSuggestions[i];
      // 如果提供了文件建议，则解析扩展名和大小
      if (suggestion && suggestion.includes(';')) {
        const parts = suggestion.split(';');
        const filenameCandidate = parts[0];
        const sizeCandidate = parseInt(parts[1]);
        if (extPattern.test(filenameCandidate)) {
          ext = filenameCandidate.match(extPattern)![0].slice(1);
        }
        if (sizeCandidate > defaults.maxSize * 1024 * 1024) {
          throw new Error(`${mediaType === 'img' ? '图片' : '视频'}超出大小限制 (${defaults.maxSize}MB)，实际大小为 ${(sizeCandidate / (1024 * 1024)).toFixed(2)}MB`);
        }
      } else if (suggestion && extPattern.test(suggestion)) {
        ext = suggestion.match(extPattern)![0].slice(1);
      }
      // 根据建议或默认值生成文件名
      let filename;
      if (suggestion && suggestion.includes(';')) {
        const parts = suggestion.split(';');
        const srcFilename = path.basename(parts[0]); // 获取原始文件名
        filename = `${caveId}_${srcFilename}`;
      } else if (suggestion && extPattern.test(suggestion)) {
        const srcFilename = path.basename(suggestion);
        filename = `${caveId}_${srcFilename}`;
      } else {
        filename = `${caveId}_${i + 1}.${ext}`;
      }
      // 拼接目标路径并发送 GET 请求下载文件
      const targetPath = path.join(resourceDir, filename);
      const response = await ctx.http(processedUrl, {
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': defaults.accept,
          'Referer': 'https://qq.com'
        }
      });
      const fileBuffer = Buffer.from(response.data);
      // 保存文件到本地
      await fs.promises.writeFile(targetPath, fileBuffer);
      savedFiles.push(filename);
    } catch (error) {
      throw new Error(`操作失败: ${error.message}`);
    }
  }
  return savedFiles;
}

// -------- 审核相关函数 --------
async function sendAuditMessage(ctx: Context, config: Config, cave: PendingCave, content: string) {
  // 发送审核消息给所有管理员
  const auditMessage = `待审核回声洞：\n${content}
来自：${cave.contributor_number}`;
  for (const managerId of config.manager) {
    try {
      // 发送私聊消息
      await ctx.bots[0]?.sendPrivateMessage(managerId, auditMessage);
    } catch (error) {
      logger.error(`操作失败: ${error.message}`);
    }
  }
}

// 审核相关函数
async function handleSingleCaveAudit(
  ctx: Context,
  cave: PendingCave,
  isApprove: boolean,
  resourceDir: string,
  data?: CaveObject[]
): Promise<boolean> {
  // 处理单个审核项，根据审批状态更新数据或删除文件
  try {
    if (isApprove && data) {
      // 保存经过清理的回声洞数据
      const caveWithoutIndex = {
        ...cave,
        elements: cleanElementsForSave(cave.elements, false)
      };
      data.push(caveWithoutIndex);
    } else if (!isApprove && cave.elements) {
      // 删除与回声洞关联的媒体文件
      for (const element of cave.elements) {
        if (element.type === 'img' && element.file) {
          const fullPath = path.join(resourceDir, element.file);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
      }
    }
    return true;
  } catch (error) {
    throw new Error(`操作失败: ${error.message}`);
  }
}

async function handleAudit(
  ctx: Context,
  pendingData: PendingCave[],
  isApprove: boolean,
  caveFilePath: string,
  resourceDir: string,
  pendingFilePath: string,
  targetId?: number
): Promise<string> {
  // 处理审核操作，支持单条及批量处理
  try {
    if (pendingData.length === 0) return '没有待审核回声洞';

    // 处理单条审核
    if (typeof targetId === 'number') {
      const pendingIndex = pendingData.findIndex(item => item.cave_id === targetId);
      if (pendingIndex === -1) return '未找到该待审核回声洞';

      const cave = pendingData[pendingIndex];
      const data = isApprove ? FileHandler.readJsonData<CaveObject>(caveFilePath) : null;

      const success = await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data);
      if (!success) return '处理失败，请稍后重试';

      if (isApprove && data) FileHandler.writeJsonData(caveFilePath, data);
      pendingData.splice(pendingIndex, 1);
      FileHandler.writeJsonData(pendingFilePath, pendingData);

      const remainingCount = pendingData.length;
      if (remainingCount > 0) {
        const remainingIds = pendingData.map(c => c.cave_id).join(', ');
        return `${isApprove ? '审核通过' : '拒绝'}成功，还有 ${remainingCount} 条待审核：[${remainingIds}]`;
      }
      return isApprove ? '已通过该回声洞' : '已拒绝该回声洞';
    }

    // 处理批量审核
    const data = isApprove ? FileHandler.readJsonData<CaveObject>(caveFilePath) : null;
    let processedCount = 0;

    for (const cave of pendingData) {
      const success = await handleSingleCaveAudit(ctx, cave, isApprove, resourceDir, data);
      if (success) processedCount++;
    }

    if (isApprove && data) FileHandler.writeJsonData(caveFilePath, data);
    FileHandler.writeJsonData(pendingFilePath, []);

    return isApprove ?
      `已通过 ${processedCount}/${pendingData.length} 条回声洞` :
      `已拒绝 ${processedCount}/${pendingData.length} 条回声洞`;
  } catch (error) {
    throw new Error(`操作失败: ${error.message}`);
  }
}

// -------- 消息构建函数 --------
function cleanElementsForSave(elements: Element[], keepIndex: boolean = false): Element[] {
  // 清理元素对象，移除无关属性，并排序
  const sorted = elements.sort((a, b) => a.index - b.index);
  return sorted.map(({ type, content, file, index }) => ({
    type,
    ...(keepIndex && { index }),
    ...(content && { content }),
    ...(file && { file })
  }));
}

// 媒体处理及回复
async function extractMediaContent(originalContent: string): Promise<{
	imageUrls: string[],
	imageElements: { type: 'img'; index: number; fileAttr?: string }[],
	videoUrls: string[],
	videoElements: { type: 'video'; index: number; fileAttr?: string }[],
	textParts: Element[]
}> {
  // 拆分文本与媒体标签，并分别提取相关信息
  const parsedTexts = originalContent
    .split(/<img[^>]+>|<video[^>]+>/g)
    .map(t => t.trim())
    .filter(t => t);
  const textParts: Element[] = [];
  parsedTexts.forEach((text, idx) => {
    textParts.push({ type: 'text', content: text, index: idx * 3 });
  });

  // 初始化数组用于存储媒体链接与元素信息
  const imageUrls: string[] = [];
  const imageElements: Array<{ type: 'img'; index: number; fileAttr?: string }> = [];
  const videoUrls: string[] = [];
  const videoElements: Array<{ type: 'video'; index: number; fileAttr?: string }> = [];

  // 提取 <img> 标签中的 src 和 file 属性
  const imgMatches = originalContent.match(/<img[^>]+src="([^"]+)"[^>]*>/g) || [];
  imgMatches.forEach((img, idx) => {
    const srcMatch = img.match(/src="([^"]+)"/);
    const fileMatch = img.match(/file="([^"]+)"(?:\s+fileSize="([^"]+)")?/);
    if (srcMatch?.[1]) {
      imageUrls.push(srcMatch[1]);
      const suggestion = fileMatch
        ? fileMatch[2]
          ? `${fileMatch[1]};${fileMatch[2]}`
          : fileMatch[1]
        : undefined;
      imageElements.push({ type: 'img', index: idx * 3 + 1, fileAttr: suggestion });
    }
  });

  // 提取 <video> 标签中的 src 与 file 属性
  const videoMatches = originalContent.match(/<video[^>]+src="([^"]+)"[^>]*>/g) || [];
  videoMatches.forEach((video, idx) => {
    const srcMatch = video.match(/src="([^"]+)"/);
    const fileMatch = video.match(/file="([^"]+)"(?:\s+fileSize="([^"]+)")?/);
    if (srcMatch?.[1]) {
      videoUrls.push(srcMatch[1]);
      const suggestion = fileMatch
        ? fileMatch[2]
          ? `${fileMatch[1]};${fileMatch[2]}`
          : fileMatch[1]
        : undefined;
      videoElements.push({ type: 'video', index: idx * 3 + 2, fileAttr: suggestion });
    }
  });

  return { imageUrls, imageElements, videoUrls, videoElements, textParts };
}

async function buildMessage(cave: CaveObject, resourceDir: string, session?: any): Promise<string> {
  // 构建回声洞消息文本，并处理视频的单独发送
  let content = `回声洞 ——（${cave.cave_id}）\n`;
  const videoElements: { file: string }[] = [];
  for (const element of cave.elements) {
    if (element.type === 'text') {
      // 追加文本段落
      content += element.content + '\n';
    } else if (element.type === 'img' && element.file) {
      try {
        const fullImagePath = path.join(resourceDir, element.file);
        if (fs.existsSync(fullImagePath)) {
          const imageBuffer = fs.readFileSync(fullImagePath);
          const base64Image = imageBuffer.toString('base64');
          content += h('image', { src: `data:image/png;base64,${base64Image}` }) + '\n';
        }
      } catch (error) {
        throw new Error(`操作失败: ${error.message}`);
      }
    } else if (element.type === 'video' && element.file) {
      // 将视频元素存入数组，待后续单独发送
      videoElements.push({ file: element.file });
    }
  }
  if (videoElements.length > 0 && session) {
    // 通知用户视频已单独发送
    content += `[视频已发送]\n`;
    for (const video of videoElements) {
      try {
        // 发送视频消息：读取视频文件并转为 base64 后发送
        const fullVideoPath = path.join(resourceDir, video.file);
        if (fs.existsSync(fullVideoPath)) {
          const videoBuffer = fs.readFileSync(fullVideoPath);
          const base64Video = videoBuffer.toString('base64');
          // 不等待 session.send 完成，异步发送视频消息
          session.send(h('video', { src: `data:video/mp4;base64,${base64Video}` }))
            .catch(error => {
              throw new Error(`操作失败: ${error.message}`);
            });
        }
      } catch (error) {
        throw new Error(`操作失败: ${error.message}`);
      }
    }
  }
  content += `—— ${cave.contributor_name}`;
  return content;
}

// -------- 初始化函数 --------
export async function initCavePaths(ctx: Context): Promise<{
  dataDir: string,
  caveDir: string,
  caveFilePath: string,
  resourceDir: string,
  pendingFilePath: string
}> {
  // 初始化回声洞目录与文件路径
  const dataDir = path.join(ctx.baseDir, 'data');
  const caveDir = path.join(dataDir, 'cave');
  const caveFilePath = path.join(caveDir, 'cave.json');
  const resourceDir = path.join(caveDir, 'resources'); // 目录名称更新
  const pendingFilePath = path.join(caveDir, 'pending.json');

  // 确保所有所需目录和 JSON 文件均存在
  await FileHandler.ensureDirectory(dataDir);
  await FileHandler.ensureDirectory(caveDir);
  await FileHandler.ensureDirectory(resourceDir); // 修改调用
  await FileHandler.ensureJsonFile(caveFilePath);
  await FileHandler.ensureJsonFile(pendingFilePath);

  return { dataDir, caveDir, caveFilePath, resourceDir, pendingFilePath };
}

// -------- 主业务函数 --------
// 修改 handleCaveAction: 调用 initCavePaths 获取各路径
export async function handleCaveAction(
  ctx: Context,
  config: Config,
  session: any,
  options: any,
  content: string[],
  lastUsed: Map<string, number>
): Promise<string> {
  // 主业务处理入口，获取基础路径信息
  const { caveFilePath, resourceDir, pendingFilePath } = await initCavePaths(ctx);

  // 提取查询投稿统计的函数（cave -l）
  async function processList(): Promise<string> {
    // 查询数据，统计投稿信息并格式化输出
    try {
      const caveData = FileHandler.readJsonData<CaveObject>(caveFilePath);
      const caveDir = path.dirname(caveFilePath);
      const stats: Record<string, number[]> = {};
      for (const cave of caveData) {
        if (cave.contributor_number === '10000') continue;
        if (!stats[cave.contributor_number]) stats[cave.contributor_number] = [];
        stats[cave.contributor_number].push(cave.cave_id);
      }
      const statFilePath = path.join(caveDir, 'stat.json');
      try {
        fs.writeFileSync(statFilePath, JSON.stringify(stats, null, 2), 'utf8');
      } catch (error) {
        throw new Error(`操作失败: ${error.message}`);
      }
      function formatIds(ids: number[]): string {
        const lines: string[] = [];
        for (let i = 0; i < ids.length; i += 10) {
          lines.push(ids.slice(i, i + 10).join(', '));
        }
        return lines.join('\n');
      }
      let queryId: string | null = null;
      if (typeof options.l === 'string') {
        const match = String(options.l).match(/\d+/);
        if (match) queryId = match[0];
      } else if (content.length > 0) {
        const numberMatch = content.join(' ').match(/\d+/);
        if (numberMatch) queryId = numberMatch[0];
      }
      if (queryId) {
        if (stats[queryId]) {
          const count = stats[queryId].length;
          return `${queryId} 共计投稿 ${count} 项回声洞:\n` + formatIds(stats[queryId]);
        } else {
          return `未找到投稿者 ${queryId}`;
        }
      } else {
        let total = 0;
        const lines = Object.entries(stats).map(([cid, ids]) => {
          total += ids.length;
          return `${cid} 共计投稿 ${ids.length} 项回声洞:\n` + formatIds(ids);
        });
        return `==回声洞共计投稿 ${total} 项==\n` + lines.join('\n');
      }
    } catch (error) {
      return `操作失败: ${error.message}`;
    }
  }

  // 提取审核操作的函数（cave -p / -d）
  async function processAudit(): Promise<string> {
    // 根据输入参数判断单条或批量审核
    try {
      const pendingData = FileHandler.readJsonData<PendingCave>(pendingFilePath);
      const isApprove = Boolean(options.p);
      if ((options.p === true && content[0] === 'all') ||
          (options.d === true && content[0] === 'all')) {
        return await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath);
      }
      const id = parseInt(content[0] ||
        (typeof options.p === 'string' ? options.p : '') ||
        (typeof options.d === 'string' ? options.d : ''));
      if (isNaN(id)) return '请输入正确的回声洞序号';
      return await handleAudit(ctx, pendingData, isApprove, caveFilePath, resourceDir, pendingFilePath, id);
    } catch (error) {
      return `操作失败: ${error.message}`;
    }
  }

  // processView 函数用于根据用户输入的回声洞序号显示该回声洞内容，并单独发送视频消息（如果有）
  async function processView(): Promise<string> {
    // 根据指定序号查找并构建回声洞消息
    try {
      const caveId = parseInt(content[0] || (typeof options.g === 'string' ? options.g : ''));
      if (isNaN(caveId)) return '请输入正确的回声洞序号';
      const data = FileHandler.readJsonData<CaveObject>(caveFilePath, item =>
        item &&
        typeof item.cave_id === 'number' &&
        Array.isArray(item.elements) &&
        item.elements.every(el =>
          (el.type === 'text' && typeof el.content === 'string') ||
          (el.type === 'img' && typeof el.file === 'string') ||
          (el.type === 'video' && typeof el.file === 'string')
        ) &&
        typeof item.contributor_number === 'string' &&
        typeof item.contributor_name === 'string'
      );
      const cave = data.find(item => item.cave_id === caveId);
      if (!cave) return '未找到该序号的回声洞';

      // 调用修改后的 buildMessage 发送视频消息内部处理
      const caveContent = await buildMessage(cave, resourceDir, session);
      return caveContent;
    } catch (error) {
      return `操作失败: ${error.message}`;
    }
  }

  // 提取随机抽取的函数
  async function processRandom(): Promise<string> {
    // 抽取符合条件的随机回声洞
    const data = FileHandler.readJsonData<CaveObject>(caveFilePath, item =>
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
    if (data.length === 0) return '暂无回声洞可用';
    const guildId = session.guildId;
    const now = Date.now();
    const lastCall = lastUsed.get(guildId) || 0;
    const isManager = config.manager.includes(session.userId);
    if (!isManager && now - lastCall < config.number * 1000) {
      const waitTime = Math.ceil((config.number * 1000 - (now - lastCall)) / 1000);
      return `群聊冷却中...请${waitTime}秒后再试`;
    }
    if (!isManager) lastUsed.set(guildId, now);
    const cave = (() => {
      const validCaves = data.filter(cave => cave.elements && cave.elements.length > 0);
      if (!validCaves.length) return undefined;
      const randomIndex = Math.floor(Math.random() * validCaves.length);
      return validCaves[randomIndex];
    })();
    return cave ? buildMessage(cave, resourceDir, session) : '获取回声洞失败';
  }

  // 提取删除操作的函数（cave -r）
  async function processDelete(): Promise<string> {
    // 校验删除权限，删除对应的媒体及数据文件，并返回预览消息
    try {
      const caveId = parseInt(content[0] || (typeof options.r === 'string' ? options.r : ''));
      if (isNaN(caveId)) return '请输入正确的回声洞序号';
      const data = FileHandler.readJsonData<CaveObject>(caveFilePath, item =>
        item && typeof item.cave_id === 'number'
      );
      const pendingData = FileHandler.readJsonData<PendingCave>(pendingFilePath);
      const index = data.findIndex(item => item.cave_id === caveId);
      const pendingIndex = pendingData.findIndex(item => item.cave_id === caveId);
      if (index === -1 && pendingIndex === -1) return '未找到该序号的回声洞';
      let targetCave: CaveObject;
      let isPending = false;
      if (index !== -1) {
        targetCave = data[index];
      } else {
        targetCave = pendingData[pendingIndex];
        isPending = true;
      }
      if (targetCave.contributor_number !== session.userId && !config.manager.includes(session.userId)) {
        return '不可删除他人添加的回声洞！';
      }

      // 先生成回声洞预览消息（图片等媒体将被嵌入）
      const caveContent = await buildMessage(targetCave, resourceDir, session);

      if (targetCave.elements) {
        try {
          for (const element of targetCave.elements) {
            if ((element.type === 'img' || element.type === 'video') && element.file) {
              const fullPath = path.join(resourceDir, element.file);
              if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            }
          }
        } catch (error) {
          return `操作失败: ${error.message}`;
        }
      }
      // 返回预览消息后再更新数据文件
      if (isPending) {
        pendingData.splice(pendingIndex, 1);
        FileHandler.writeJsonData(pendingFilePath, pendingData);
        return `已删除（待审核）\n${caveContent}`;
      } else {
        data.splice(index, 1);
        FileHandler.writeJsonData(caveFilePath, data);
        return `已删除\n${caveContent}`;
      }
    } catch (error) {
      return `操作失败: ${error.message}`;
    }
  }

  // 修改 processAdd：将缺少媒体及文本的回复逻辑移入 processAdd，并调用 extractMediaContent 提取文本处理
  async function processAdd(): Promise<string> {
    // 提示用户输入内容并解析媒体及文本信息
    try {
      // 修改原始内容变量声明为 let 以便后续修改
      let originalContent = session.quote?.content || session.content;
      // 新增：移除命令前缀
      const prefixes = Array.isArray(session.app.config.prefix)
        ? session.app.config.prefix
        : [session.app.config.prefix];
      const nicknames = Array.isArray(session.app.config.nickname)
        ? session.app.config.nickname
        : session.app.config.nickname ? [session.app.config.nickname] : [];
      const allTriggers = [...prefixes, ...nicknames];
      const triggerPattern = allTriggers
        .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      const commandPattern = new RegExp(`^(?:${triggerPattern}).*?-a\\s*`);
      originalContent = originalContent.replace(commandPattern, '');

      // 提取原始内容
      let { imageUrls, imageElements, videoUrls, videoElements, textParts } = await extractMediaContent(originalContent);

      // 当媒体和文本均为空时，进行回复提示
      if (textParts.length === 0 && imageUrls.length === 0 && videoUrls.length === 0) {
        await session.send('请在一分钟内发送你要添加的内容');
        const reply = await session.prompt({ timeout: 60000 });
        if (!reply || reply.trim() === "") {
          return '操作超时，放弃本次添加';
        }
        const replyResult = await extractMediaContent(reply);
        imageUrls = replyResult.imageUrls;
        imageElements = replyResult.imageElements;
        videoUrls = replyResult.videoUrls;
        videoElements = replyResult.videoElements;
        textParts = replyResult.textParts;
      }

      // 检查配置：是否允许添加视频
      if (videoUrls.length > 0 && !config.allowVideo) {
        return '已关闭上传视频功能';
      }

      // 生成新的回声洞ID及处理媒体文件
      const pendingData = FileHandler.readJsonData<PendingCave>(pendingFilePath);
      const data = FileHandler.readJsonData<CaveObject>(caveFilePath, item => item && typeof item.cave_id === 'number');
      const maxDataId = data.length > 0 ? Math.max(...data.map(item => item.cave_id)) : 0;
      const maxPendingId = pendingData.length > 0 ? Math.max(...pendingData.map(item => item.cave_id)) : 0;
      const caveId = Math.max(maxDataId, maxPendingId) + 1;
      let savedImages: string[] = [];
      if (imageUrls.length > 0) {
        try {
          const fileSuggestions = imageElements.map(el => el.fileAttr);
          savedImages = await saveMedia(imageUrls, fileSuggestions, resourceDir, caveId, config, ctx, 'img');
        } catch (error) {
          return `操作失败: ${error.message}`;
        }
      }
      let savedVideos: string[] = [];
      if (videoUrls.length > 0) {
        try {
          const fileSuggestions = videoElements.map(el => el.fileAttr);
          savedVideos = await saveMedia(videoUrls, fileSuggestions, resourceDir, caveId, config, ctx, 'video');
        } catch (error) {
          return `操作失败: ${error.message}`;
        }
      }

      // 合并所有元素：文本/图片/视频
      const elements: Element[] = [];
      elements.push(...textParts);
      savedImages.forEach((file, idx) => {
        if (imageElements[idx]) {
          elements.push({ ...imageElements[idx], type: 'img', file });
        }
      });
      savedVideos.forEach((file, idx) => {
        if (videoElements[idx]) {
          elements.push({ ...videoElements[idx], type: 'video', file });
        }
      });
      elements.sort((a, b) => a.index - b.index);

      // 获取投稿者信息保持不变
      let contributorName = session.username;
      if (ctx.database) {
        try {
          const userInfo = await ctx.database.getUser(session.platform, session.userId);
          contributorName = (userInfo as unknown as User)?.nickname || session.username;
        } catch (error) {
          throw new Error(`操作失败: ${error.message}`);
        }
      }

      const newCave: CaveObject = {
        cave_id: caveId,
        elements: cleanElementsForSave(elements, true),
        contributor_number: session.userId,
        contributor_name: contributorName
      };

      if (config.enableAudit) {
        pendingData.push({ ...newCave, elements: cleanElementsForSave(elements, true) });
        FileHandler.writeJsonData(pendingFilePath, pendingData);
        await sendAuditMessage(ctx, config, newCave, await buildMessage(newCave, resourceDir, session));
        return `已提交审核，序号为 (${caveId})`;
      }

      const caveWithoutIndex = { ...newCave, elements: cleanElementsForSave(elements, false) };
      data.push(caveWithoutIndex);
      FileHandler.writeJsonData(caveFilePath, data);
      return `添加成功！序号为 (${caveId})`;
    } catch (error) {
      return `操作失败: ${error.message}`;
    }
  }

  try {
    // 根据不同命令参数调用对应处理函数
    if (options.l !== undefined) return await processList();
    if (options.p || options.d) return await processAudit();
    if (options.g) return await processView();
    if (options.r) return await processDelete();
    if (options.a) return await processAdd();
    return await processRandom();
  } catch (error) {
    // 将错误信息返回给用户
    return `操作失败: ${error.message.replace(/^操作失败: /, '')}`;
  }
}
