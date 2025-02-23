import { Context, Logger, h } from 'koishi';
import * as fs from 'fs';
import * as path from 'path';
import { MediaElement, Element, CaveObject } from '..';
import { FileHandler } from './FileHandler';
import { HashManager } from './HashManager';

const logger = new Logger('MediaHandle');

/**
 * 构建并返回洞窟消息内容
 * @param cave - 洞窟对象
 * @param resourceDir - 资源目录路径
 * @param session - 会话对象
 * @returns 格式化后的消息字符串
 */
export async function buildMessage(cave: CaveObject, resourceDir: string, session?: any): Promise<string> {
  if (!cave?.elements?.length) {
    return session.text('commands.cave.error.noContent');
  }

  // 分离视频元素和其他元素，并按index排序
  const videoElement = cave.elements.find((el): el is MediaElement => el.type === 'video');
  const nonVideoElements = cave.elements
    .filter(el => el.type !== 'video')
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // 有视频元素
  if (videoElement?.file) {

    const basicInfo = [
      session.text('commands.cave.message.caveTitle', [cave.cave_id]),
      session.text('commands.cave.message.contributorSuffix', [cave.contributor_name])
    ].join('\n');

    await session?.send(basicInfo);

    const filePath = path.join(resourceDir, videoElement.file);
    const base64Data = await processMediaFile(filePath, 'video');
    if (base64Data && session) {
      await session.send(h('video', { src: base64Data }));
    }
    return '';
  }

  // 没有视频元素
  const lines = [session.text('commands.cave.message.caveTitle', [cave.cave_id])];

  for (const element of nonVideoElements) {
    if (element.type === 'text') {
      lines.push(element.content);
    } else if (element.type === 'img' && element.file) {
      const filePath = path.join(resourceDir, element.file);
      const base64Data = await processMediaFile(filePath, 'image');
      if (base64Data) {
        lines.push(h('image', { src: base64Data }));
      }
    }
  }

  lines.push(session.text('commands.cave.message.contributorSuffix', [cave.contributor_name]));
  return lines.join('\n');
}

/**
 * 发送临时或永久消息
 * @param session - 会话对象
 * @param key - 消息key
 * @param params - 消息参数数组
 * @param isTemp - 是否为临时消息
 * @param timeout - 临时消息超时时间(ms)
 * @returns 空字符串
 */
export async function sendMessage(
  session: any,
  key: string,
  params: any[] = [],
  isTemp = true,
  timeout = 10000
): Promise<string> {
  try {
    const msg = await session.send(session.text(key, params));
    if (isTemp && msg) {
      setTimeout(async () => {
        try {
          await session.bot.deleteMessage(session.channelId, msg);
        } catch (error) {
          logger.debug(`Failed to delete temporary message: ${error.message}`);
        }
      }, timeout);
    }
  } catch (error) {
    logger.error(`Failed to send message: ${error.message}`);
  }
  return '';
}

/**
 * 处理媒体文件，返回文件路径或base64编码
 * @param filePath - 文件路径
 * @param type - 媒体类型('image' | 'video')
 * @returns 图片路径或视频base64编码
 */
export async function processMediaFile(filePath: string, type: 'image' | 'video'): Promise<string | null> {
  const data = await fs.promises.readFile(filePath).catch(() => null);
  if (!data) return null;
  return `data:${type}/${type === 'image' ? 'png' : 'mp4'};base64,${data.toString('base64')}`;
}

/**
 * 从内容中提取媒体元素
 * @param originalContent - 原始内容字符串
 * @param config - 配置对象，包含图片和视频大小限制
 * @param session - 会话对象
 * @returns 包含图片、视频URL和元素的对象
 */
export async function extractMediaContent(
  originalContent: string,
  config: { imageMaxSize: number; videoMaxSize: number },
  session: any
): Promise<{
  imageUrls: string[],
  imageElements: Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>,
  videoUrls: string[],
  videoElements: Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>,
  textParts: Element[]
}> {
  const textParts = originalContent
    .split(/<(img|video)[^>]+>/)
    .map((text, idx) => text.trim() && ({
      type: 'text' as const,
      content: text.replace(/^(img|video)$/, '').trim(),
      index: idx * 3
    }))
    .filter(text => text && text.content);

  const getMediaElements = (type: 'img' | 'video', maxSize: number) => {
    const regex = new RegExp(`<${type}[^>]+src="([^"]+)"[^>]*>`, 'g');
    const elements: Array<{ type: typeof type; index: number; fileName?: string; fileSize?: string }> = [];
    const urls: string[] = [];

    let match;
    let idx = 0;
    while ((match = regex.exec(originalContent)) !== null) {
      const element = match[0];
      const url = match[1];
      const fileName = element.match(/file="([^"]+)"/)?.[1];
      const fileSize = element.match(/fileSize="([^"]+)"/)?.[1];

      if (fileSize) {
        const sizeInBytes = parseInt(fileSize);
        if (sizeInBytes > maxSize * 1024 * 1024) {
          throw new Error(session.text('commands.cave.message.mediaSizeExceeded', [type]));
        }
      }

      urls.push(url);
      elements.push({
        type,
        index: type === 'video' ? Number.MAX_SAFE_INTEGER : idx * 3 + 1,
        fileName,
        fileSize
      });
      idx++;
    }
    return { urls, elements };
  };

  const { urls: imageUrls, elements: imageElementsRaw } = getMediaElements('img', config.imageMaxSize);
  const imageElements = imageElementsRaw as Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>;
  const { urls: videoUrls, elements: videoElementsRaw } = getMediaElements('video', config.videoMaxSize);
  const videoElements = videoElementsRaw as Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>;

  return { imageUrls, imageElements, videoUrls, videoElements, textParts };
}

/**
 * 保存媒体文件
 * @param urls - 媒体URL数组
 * @param fileNames - 文件名数组
 * @param resourceDir - 资源目录路径
 * @param caveId - 洞窟ID
 * @param mediaType - 媒体类型('img' | 'video')
 * @param config - 配置对象，包含重复检查相关设置
 * @param ctx - Koishi上下文
 * @param session - 会话对象
 * @param buffers - 可选的buffer数组，用于收集图片buffer
 * @returns 保存后的文件名数组
 */
export async function saveMedia(
  urls: string[],
  fileNames: (string | undefined)[],
  resourceDir: string,
  caveId: number,
  mediaType: 'img' | 'video',
  config: { enableImageDuplicate: boolean; imageDuplicateThreshold: number; textDuplicateThreshold: number },
  ctx: Context,
  session: any,
  buffers?: Buffer[]
): Promise<string[]> {
  const accept = mediaType === 'img' ? 'image/*' : 'video/*';
  const hashStorage = new HashManager(path.join(ctx.baseDir, 'data', 'cave'));
  await hashStorage.initialize();

  const downloadTasks = urls.map(async (url, i) => {
    const fileName = fileNames[i];
    const ext = path.extname(fileName || url) || (mediaType === 'img' ? '.png' : '.mp4');

    try {
      const response = await ctx.http(decodeURIComponent(url).replace(/&amp;/g, '&'), {
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': accept,
          'Referer': 'https://qq.com'
        }
      });

      if (!response.data) throw new Error('empty_response');
      const buffer = Buffer.from(response.data);
      if (buffers && mediaType === 'img') {
        buffers.push(buffer);
      }

      const md5 = path.basename(fileName || `${mediaType}`, ext).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
      const files = await fs.promises.readdir(resourceDir);
      const duplicateFile = files.find(file => {
        const match = file.match(/^\d+_([^.]+)/);
        return match && match[1] === md5;
      });

      if (duplicateFile) {
        const duplicateCaveId = parseInt(duplicateFile.split('_')[0]);
        if (!isNaN(duplicateCaveId)) {
          const caveFilePath = path.join(ctx.baseDir, 'data', 'cave', 'cave.json');
          const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
          const originalCave = data.find(item => item.cave_id === duplicateCaveId);

          if (originalCave) {
            const message = session.text('commands.cave.error.exactDuplicateFound');
            await session.send(message + await buildMessage(originalCave, resourceDir, session));
            throw new Error('duplicate_found');
          }
        }
      }

      if (mediaType === 'img' && config.enableImageDuplicate) {
        const result = await hashStorage.findDuplicates(
          { images: [buffer] },
          {
            image: config.imageDuplicateThreshold,
            text: config.textDuplicateThreshold
          }
        );

        if (result.length > 0 && result[0] !== null) {
          const duplicate = result[0];
          const similarity = duplicate.similarity;

          if (similarity >= config.imageDuplicateThreshold) {
            const caveFilePath = path.join(ctx.baseDir, 'data', 'cave', 'cave.json');
            const data = await FileHandler.readJsonData<CaveObject>(caveFilePath);
            const originalCave = data.find(item => item.cave_id === duplicate.caveId);

            if (originalCave) {
              const message = session.text('commands.cave.error.similarDuplicateFound',
                [(similarity * 100).toFixed(1)]);
              await session.send(message + await buildMessage(originalCave, resourceDir, session));
              throw new Error('duplicate_found');
            }
          }
        }
      }

      const finalFileName = `${caveId}_${md5}${ext}`;
      const filePath = path.join(resourceDir, finalFileName);
      await FileHandler.saveMediaFile(filePath, buffer);
      return finalFileName;

    } catch (error) {
      if (error.message === 'duplicate_found') {
        throw error;
      }
      logger.error(`Failed to download media: ${error.message}`);
      throw new Error(session.text(`commands.cave.error.upload${mediaType === 'img' ? 'Image' : 'Video'}Failed`));
    }
  });
  return Promise.all(downloadTasks);
}
