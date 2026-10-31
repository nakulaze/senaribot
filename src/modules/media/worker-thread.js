import { parentPort } from 'worker_threads';
import { access, unlink } from 'fs/promises';
import { constants } from 'fs';
import sharp from 'sharp';
import { MEDIA_SHARP_QUALITY, MEDIA_STICKER_SIZE_PX } from '@/config/constants.js';

async function processImage(inputPath: string, outputPath: string, options: any): Promise<void> {
  let pipeline = sharp(inputPath);

  if (options?.sticker) {
    pipeline = pipeline.resize(MEDIA_STICKER_SIZE_PX, MEDIA_STICKER_SIZE_PX, {
      fit: 'cover',
      position: 'center',
    });
  } else if (options?.resize) {
    const { width, height } = options.resize;
    pipeline = pipeline.resize(width, height, { fit: 'inside', withoutEnlargement: true });
  }

  if (options?.quality) {
    pipeline = pipeline.jpeg({ quality: options.quality });
  } else {
    pipeline = pipeline.jpeg({ quality: MEDIA_SHARP_QUALITY });
  }

  await pipeline.toFile(outputPath);
}

async function processMedia(jobData: any): Promise<void> {
  const { id, type, inputPath, outputPath, options } = jobData;

  try {
    await access(inputPath, constants.R_OK);

    switch (type) {
      case 'image':
      case 'sticker':
        await processImage(inputPath, outputPath, options);
        break;
      case 'video':
      case 'audio':
        await processImage(inputPath, outputPath, options);
        break;
      default:
        throw new Error(`Unsupported media type: ${type}`);
    }

    parentPort?.postMessage({
      id,
      success: true,
      outputPath,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    parentPort?.postMessage({
      id,
      success: false,
      error: errorMsg,
    });
  }
}

parentPort?.on('message', (job) => {
  processMedia(job);
});
