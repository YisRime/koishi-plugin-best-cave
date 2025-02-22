import { Context, Logger } from 'koishi';
import * as fs from 'fs';
import * as path from 'path';
import { FileHandler } from './FileHandle';
import { ContentHashManager } from './HashManage';

const logger = new Logger('MediaHandle');

export interface BaseElement {
  type: 'text' | 'img' | 'video';
  index: number;
}

export interface TextElement extends BaseElement {
  type: 'text';
  content: string;
}

export interface MediaElement extends BaseElement {
  type: 'img' | 'video';
  file?: string;
  fileName?: string;
  fileSize?: string;
  filePath?: string;
}

export type Element = TextElement | MediaElement;

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

  // 分别检查图片和视频
  const { urls: imageUrls, elements: imageElementsRaw } = getMediaElements('img', config.imageMaxSize);
  const imageElements = imageElementsRaw as Array<{ type: 'img'; index: number; fileName?: string; fileSize?: string }>;
  const { urls: videoUrls, elements: videoElementsRaw } = getMediaElements('video', config.videoMaxSize);
  const videoElements = videoElementsRaw as Array<{ type: 'video'; index: number; fileName?: string; fileSize?: string }>;

  return { imageUrls, imageElements, videoUrls, videoElements, textParts };
}

export async function saveMedia(
  urls: string[],
  fileNames: (string | undefined)[],
  resourceDir: string,
  caveId: number,
  mediaType: 'img' | 'video',
  config: { enableImageDuplicate: boolean; imageDuplicateThreshold: number; textDuplicateThreshold: number },
  ctx: Context,
  session: any,
  buffers?: Buffer[] // 新增参数用于收集buffer
): Promise<string[]> {
  const accept = mediaType === 'img' ? 'image/*' : 'video/*';
  const hashStorage = new ContentHashManager(path.join(ctx.baseDir, 'data', 'cave'));
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

      // 获取MD5作为基础文件名 (对图片和视频统一处理)
      const md5 = path.basename(fileName || `${mediaType}`, ext).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');

      // 使用相同的重复检查逻辑
      const files = await fs.promises.readdir(resourceDir);
      const duplicateFile = files.find(file => {
        const match = file.match(/^\d+_([^.]+)/);  // 匹配 数字_MD5 格式
        return match && match[1] === md5;  // 比较MD5部分
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

      // 相似度检查仅对图片进行
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

      // 统一的文件名格式
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

interface CaveObject {
  cave_id: number;
  elements: Element[];
  contributor_number: string;
  contributor_name: string;
}

async function buildMessage(cave: CaveObject, resourceDir: string, session?: any): Promise<string> {
  if (!cave?.elements?.length) {
    return session.text('commands.cave.error.noContent');
  }

  const lines = [session.text('commands.cave.message.caveTitle', [cave.cave_id])];
  for (const element of cave.elements) {
    if (element.type === 'text') {
      lines.push((element as TextElement).content);
    }
  }
  lines.push(session.text('commands.cave.message.contributorSuffix', [cave.contributor_name]));
  return lines.join('\n');
}
