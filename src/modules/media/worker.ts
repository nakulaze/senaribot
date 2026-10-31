import { Worker } from 'worker_threads';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { childLogger } from '@/utils/logger.js';
import { MEDIA_WORKER_TIMEOUT_MS } from '@/config/constants.js';

const log = childLogger('media/worker');
const __dirname = join(fileURLToPath(import.meta.url), '..');

export interface MediaJob {
  id: string;
  type: 'image' | 'video' | 'audio' | 'sticker';
  inputPath: string;
  outputPath: string;
  options?: Record<string, any>;
}

export interface JobResult {
  id: string;
  success: boolean;
  outputPath?: string;
  error?: string;
}

export class MediaWorkerPool {
  private workers: Array<{ worker: Worker; busy: boolean }> = [];
  private jobQueue: Array<{ job: MediaJob; resolve: (result: JobResult) => void; reject: (error: Error) => void }> = [];
  private activeJobs = new Map<string, NodeJS.Timeout>();

  constructor(poolSize: number = 2) {
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(join(__dirname, 'worker-thread.js'));
      worker.on('message', (msg: JobResult) => {
        this.handleJobComplete(msg);
      });
      worker.on('error', (err) => {
        log.error(err, 'worker error');
      });
      this.workers.push({ worker, busy: false });
    }
  }

  async processMedia(job: MediaJob): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.activeJobs.delete(job.id);
        reject(new Error(`Media processing timeout for job ${job.id}`));
      }, MEDIA_WORKER_TIMEOUT_MS);

      this.activeJobs.set(job.id, timeout);
      this.jobQueue.push({ job, resolve, reject });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.jobQueue.length === 0) return;

    const availableWorkerEntry = this.workers.find(w => !w.busy);
    if (!availableWorkerEntry) return;

    const { job } = this.jobQueue.shift()!;
    availableWorkerEntry.busy = true;
    availableWorkerEntry.worker.postMessage(job);
  }

  private handleJobComplete(result: JobResult): void {
    const timeout = this.activeJobs.get(result.id);
    if (timeout) {
      clearTimeout(timeout);
      this.activeJobs.delete(result.id);
    }

    const workerEntry = this.workers.find(() => {
      return this.jobQueue.find(item => item.job.id === result.id) !== undefined;
    });

    if (workerEntry) {
      workerEntry.busy = false;
    }

    const queueItem = this.jobQueue.find(item => item.job.id === result.id);
    if (queueItem) {
      this.jobQueue = this.jobQueue.filter(item => item.job.id !== result.id);
      if (result.success) {
        queueItem.resolve(result);
      } else {
        queueItem.reject(new Error(result.error || 'Unknown error'));
      }
    }

    this.processQueue();
  }

  shutdown(): void {
    for (const { worker } of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.jobQueue = [];
    this.activeJobs.clear();
  }
}

