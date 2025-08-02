import { Context, h, Logger, Session } from 'koishi';
import * as path from 'path';
import { CaveObject, Config, StoredElement, CaveHashObject } from './index';
import { FileManager } from './FileManager';
import { HashManager } from './HashManager';

const mimeTypeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.webp': 'image/webp' };

/**
 * @description 一个特殊的标志，当它存在于可复用ID缓存中时，表示数据库ID连续，下次可直接取最大ID+1。
 */
const MAX_ID_FLAG = 0;

/**
 * @description 将数据库存储的 StoredElement[] 转换为 Koishi 的 h() 元素数组。
 * @param elements 从数据库读取的元素数组。
 * @returns 转换后的 h() 元素数组。
 */
export function storedFormatToHElements(elements: StoredElement[]): h[] {
  return elements.map(el => {
    if (el.type === 'text') return h.text(el.content);
    if (['image', 'video', 'audio', 'file'].includes(el.type)) return h(el.type, { src: el.file });
    return null;
  }).filter(Boolean); // 过滤掉无效元素
}

/**
 * @description 构建一条用于发送的完整回声洞消息。
 * 此函数会处理 S3 URL、文件映射路径或本地文件到 Base64 的转换。
 * @param cave 要展示的回声洞对象。
 * @param config 插件配置。
 * @param fileManager FileManager 实例。
 * @param logger Logger 实例。
 * @returns 包含 h() 元素和字符串的消息数组。
 */
export async function buildCaveMessage(cave: CaveObject, config: Config, fileManager: FileManager, logger: Logger): Promise<(string | h)[]> {
  const caveHElements = storedFormatToHElements(cave.elements);

  const processedElements = await Promise.all(caveHElements.map(async (element) => {
    const isMedia = ['image', 'video', 'audio', 'file'].includes(element.type);
    const fileName = element.attrs.src as string;

    if (!isMedia || !fileName) return element;

    if (config.enableS3 && config.publicUrl) {
      const fullUrl = new URL(fileName, config.publicUrl).href;
      return h(element.type, { ...element.attrs, src: fullUrl });
    }
    if (config.localPath) {
      return h(element.type, { ...element.attrs, src: `file://${path.join(config.localPath, fileName)}` });
    }
    try {
      const data = await fileManager.readFile(fileName);
      const mimeType = mimeTypeMap[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
      return h(element.type, { ...element.attrs, src: `data:${mimeType};base64,${data.toString('base64')}` });
    } catch (error) {
      logger.warn(`转换文件 ${fileName} 为 Base64 失败:`, error);
      return h('p', {}, `[${element.type}]`);
    }
  }));

  const replacements = { id: cave.id.toString(), name: cave.userName };
  const formatPart = (part: string) => part.replace(/\{id\}|\{name\}/g, match => replacements[match.slice(1, -1)]).trim();
  const [header, footer] = config.caveFormat.split('|', 2).map(formatPart);

  const finalMessage: (string | h)[] = [];
  if (header) finalMessage.push(header + '\n');
  finalMessage.push(...processedElements);
  if (footer) finalMessage.push('\n' + footer);

  return finalMessage;
}

/**
 * @description 清理数据库中所有被标记为 'delete' 状态的回声洞及其关联文件。
 * @param ctx Koishi 上下文。
 * @param fileManager FileManager 实例。
 * @param logger Logger 实例。
 * @param reusableIds 可复用 ID 的内存缓存。
 */
export async function cleanupPendingDeletions(ctx: Context, fileManager: FileManager, logger: Logger, reusableIds: Set<number>): Promise<void> {
  try {
    const cavesToDelete = await ctx.database.get('cave', { status: 'delete' });
    if (!cavesToDelete.length) return;

    for (const cave of cavesToDelete) {
      const deletePromises = cave.elements
        .filter(el => el.file)
        .map(el => fileManager.deleteFile(el.file));
      await Promise.all(deletePromises);
      reusableIds.add(cave.id);
      reusableIds.delete(MAX_ID_FLAG);
      await ctx.database.remove('cave', { id: cave.id });
      await ctx.database.remove('cave_hash', { cave: cave.id });
    }
  } catch (error) {
    logger.error('清理回声洞时发生错误:', error);
  }
}

/**
 * @description 根据配置（是否分群）和当前会话，生成数据库查询的范围条件。
 * @param session 当前会话对象。
 * @param config 插件配置。
 * @returns 用于数据库查询的条件对象。
 */
export function getScopeQuery(session: Session, config: Config): object {
  const baseQuery = { status: 'active' as const };
  return config.perChannel && session.channelId ? { ...baseQuery, channelId: session.channelId } : baseQuery;
}

/**
 * @description 获取下一个可用的回声洞 ID。
 * 实现了三阶段逻辑：优先使用回收ID -> 扫描空闲ID -> 获取最大ID+1。
 * @param ctx Koishi 上下文。
 * @param query 查询范围条件，用于分群模式。
 * @param reusableIds 可复用 ID 的内存缓存。
 * @returns 可用的新 ID。
 */
export async function getNextCaveId(ctx: Context, query: object = {}, reusableIds: Set<number>): Promise<number> {
  // 优先使用缓存中已回收的 ID (ID > 0)
  for (const id of reusableIds) {
    if (id > MAX_ID_FLAG) {
      reusableIds.delete(id);
      return id;
    }
  }

  // 如果缓存中有特殊标志，说明之前已确认ID连续，直接取最大ID+1
  if (reusableIds.has(MAX_ID_FLAG)) {
    reusableIds.delete(MAX_ID_FLAG); // 使用后即移除标志
    const [lastCave] = await ctx.database.get('cave', query, {
      fields: ['id'],
      sort: { id: 'desc' },
      limit: 1,
    });
    const newId = (lastCave?.id || 0) + 1;
    // 为下一次调用重新设置标志，因为我们确信现在仍然是连续的
    reusableIds.add(MAX_ID_FLAG);
    return newId;
  }

  // 缓存为空（通常在重启后）或只包含无效ID，进行一次全量扫描
  const allCaveIds = (await ctx.database.get('cave', query, { fields: ['id'] })).map(c => c.id);
  const existingIds = new Set(allCaveIds);

  // 寻找最小的未被使用的正整数ID
  let newId = 1;
  while (existingIds.has(newId)) {
    newId++;
  }

  // 检查ID是否连续。如果连续（数据库中的记录数等于最大ID值），则设置特殊标志，
  // 以便下次调用时可以跳过扫描。
  const maxIdInDb = allCaveIds.length > 0 ? Math.max(...allCaveIds) : 0;
  if (existingIds.size === maxIdInDb) {
    reusableIds.add(MAX_ID_FLAG);
  }

  return newId;
}

/**
 * @description 检查用户是否处于指令冷却中。
 * @returns 若在冷却中则返回提示字符串，否则返回 null。
 */
export function checkCooldown(session: Session, config: Config, lastUsed: Map<string, number>): string | null {
  if (config.coolDown <= 0 || !session.channelId) return null;
  const lastTime = lastUsed.get(session.channelId) || 0;
  const remainingTime = (lastTime + config.coolDown * 1000) - Date.now();
  if (remainingTime > 0) {
    return `指令冷却中，请在 ${Math.ceil(remainingTime / 1000)} 秒后重试`;
  }
  return null;
}

/**
 * @description 更新指定频道的指令使用时间戳。
 */
export function updateCooldownTimestamp(session: Session, config: Config, lastUsed: Map<string, number>) {
  if (config.coolDown > 0 && session.channelId) {
    lastUsed.set(session.channelId, Date.now());
  }
}

/**
 * @description 解析消息元素，分离出文本和待下载的媒体文件。
 * @param sourceElements - 原始的 Koishi 消息元素数组。
 * @param newId - 这条回声洞的新 ID。
 * @param channelId - 频道 ID。
 * @param userId - 用户 ID。
 * @returns 一个包含数据库元素和待保存媒体列表的对象。
 */
export async function processMessageElements(sourceElements: h[], newId: number, channelId: string, userId: string): Promise<{
  finalElementsForDb: StoredElement[],
  mediaToSave: { sourceUrl: string, fileName: string }[]
}> {
  const finalElementsForDb: StoredElement[] = [];
  const mediaToSave: { sourceUrl: string, fileName: string }[] = [];
  let mediaIndex = 0;

  const typeMap: Record<string, StoredElement['type']> = {
    'img': 'image', 'image': 'image', 'video': 'video', 'audio': 'audio', 'file': 'file', 'text': 'text'
  };
  const defaultExtMap = { 'image': '.jpg', 'video': '.mp4', 'audio': '.mp3', 'file': '.dat' };

  async function traverse(elements: h[]) {
    for (const el of elements) {
      const normalizedType = typeMap[el.type];
      if (normalizedType) {
        if (['image', 'video', 'audio', 'file'].includes(normalizedType) && el.attrs.src) {
          let fileIdentifier = el.attrs.src as string;
          if (fileIdentifier.startsWith('http')) {
            const ext = path.extname(el.attrs.file as string || '') || defaultExtMap[normalizedType];
            const fileName = `${newId}_${++mediaIndex}_${channelId || 'private'}_${userId}${ext}`;
            mediaToSave.push({ sourceUrl: fileIdentifier, fileName });
            fileIdentifier = fileName;
          }
          finalElementsForDb.push({ type: normalizedType, file: fileIdentifier });
        } else if (normalizedType === 'text' && el.attrs.content?.trim()) {
          finalElementsForDb.push({ type: 'text', content: el.attrs.content.trim() });
        }
      }
      if (el.children) await traverse(el.children);
    }
  }

  await traverse(sourceElements);
  return { finalElementsForDb, mediaToSave };
}

/**
 * @description 异步处理文件上传、查重和状态更新的后台任务。
 * @param ctx - Koishi 上下文。
 * @param config - 插件配置。
 * @param fileManager - FileManager 实例，用于保存文件。
 * @param logger - 日志记录器实例。
 * @param reviewManager - ReviewManager 实例，用于提交审核。
 * @param cave - 刚刚在数据库中创建的 `preload` 状态的回声洞对象。
 * @param mediaToSave - 需要下载和处理的媒体文件列表。
 * @param reusableIds - 可复用 ID 的内存缓存。
 * @param session - 触发此操作的用户会话，用于发送反馈。
 * @param hashManager - HashManager 实例，如果启用则用于哈希计算和比较。
 * @param textHashesToStore - 已预先计算好的、待存入数据库的文本哈希对象数组。
 */
export async function handleFileUploads(ctx: Context, config: Config, fileManager: FileManager, logger: Logger, reviewManager: any, cave: CaveObject, mediaToSave: { sourceUrl: string, fileName: string }[], reusableIds: Set<number>, session: Session, hashManager: HashManager | null, textHashesToStore: Omit<CaveHashObject, 'cave'>[]) {
  try {
    const downloadedMedia: { fileName: string, buffer: Buffer }[] = [];
    const imageHashesToStore: Omit<CaveHashObject, 'cave'>[] = [];
    let allNewImageHashes: string[] = [];

    if (hashManager) {
      for (const media of mediaToSave) {
        const response = await ctx.http.get(media.sourceUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const buffer = Buffer.from(response);
        downloadedMedia.push({ fileName: media.fileName, buffer });

        const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(media.fileName).toLowerCase());
        if (isImage) {
          const pHash = await hashManager.generateImagePHash(buffer);
          const subHashes = [...await hashManager.generateImageSubHashes(buffer)];

          allNewImageHashes.push(pHash, ...subHashes);

          imageHashesToStore.push({ hash: pHash, type: 'image', subType: 'pHash' });
          subHashes.forEach(sh => imageHashesToStore.push({ hash: sh, type: 'image', subType: 'subImage' }));
        }
      }

      // 进行图片相似度校验
      if (allNewImageHashes.length > 0) {
        const existingImageHashes = await ctx.database.get('cave_hash', { type: 'image' });
        for (const newHash of allNewImageHashes) {
          for (const existing of existingImageHashes) {
            const similarity = hashManager.calculateImageSimilarity(newHash, existing.hash);
            if (similarity >= config.imageThreshold) {
              await session.send(`图片与回声洞（${existing.cave}）的相似度（${(similarity * 100).toFixed(2)}%）过高`);
              await ctx.database.upsert('cave', [{ id: cave.id, status: 'delete' }]);
              cleanupPendingDeletions(ctx, fileManager, logger, reusableIds);
              return; // 终止后续操作
            }
          }
        }
      }
    } else {
      // 如果未启用哈希，正常下载文件
      for (const media of mediaToSave) {
        const response = await ctx.http.get(media.sourceUrl, { responseType: 'arraybuffer', timeout: 30000 });
        downloadedMedia.push({ fileName: media.fileName, buffer: Buffer.from(response) });
      }
    }

    await Promise.all(downloadedMedia.map(item => fileManager.saveFile(item.fileName, item.buffer)));

    const finalStatus = config.enableReview ? 'pending' : 'active';
    await ctx.database.upsert('cave', [{ id: cave.id, status: finalStatus }]);

    if (hashManager) {
      const allHashesToInsert = [
        ...textHashesToStore.map(h => ({ ...h, cave: cave.id })),
        ...imageHashesToStore.map(h => ({ ...h, cave: cave.id }))
      ];
      if (allHashesToInsert.length > 0) {
        await ctx.database.upsert('cave_hash', allHashesToInsert);
      }
    }

    if (finalStatus === 'pending' && reviewManager) {
      const [finalCave] = await ctx.database.get('cave', { id: cave.id });
      if (finalCave) reviewManager.sendForReview(finalCave);
    }
  } catch (fileProcessingError) {
    logger.error(`回声洞（${cave.id}）文件处理失败:`, fileProcessingError);
    await ctx.database.upsert('cave', [{ id: cave.id, status: 'delete' }]);
    cleanupPendingDeletions(ctx, fileManager, logger, reusableIds);
  }
}
