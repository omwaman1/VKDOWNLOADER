/**
 * Standalone Video Downloader
 * Decrypts ClassX video details and downloads the single Matroska (.mkv) file.
 * Automatically XORs the first 28 bytes on-the-fly.
 * Bypasses the need for segment aggregation.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

class DownloadManager {
  constructor(wsBroadcast, apiGet, apiHeaders) {
    this.queue = [];
    this.activeDownloads = 0;
    this.maxConcurrent = 4; // Concurrency of concurrent file downloads
    this.paused = false;
    this.wsBroadcast = wsBroadcast || (() => {});
    this.apiGet = apiGet;
    this.apiHeaders = apiHeaders;
    this.abortControllers = new Map(); // videoId -> AbortController-like flag
    this.activeRequests = new Map();  // videoId -> HTTP request object
  }

  /**
   * Add videos to download queue.
   */
  addToQueue(videos, quality, downloadPath) {
    let addedCount = 0;
    for (const video of videos) {
      if (this.queue.find(q => q.id === video.id && q.quality === (video.quality || quality))) {
        continue;
      }

      const itemTitle = this.sanitizeFilename(video.title || `video_${video.id}`);
      const itemQuality = video.quality || quality || '480p';
      const itemDownloadPath = downloadPath || 'C:\\Users\\Admin1\\Downloads\\VKDOWNLOADER-main\\VKDOWNLOADER-main\\downloads\\OneDrive - wrzdw\\STUDY\\VKCLASS';
      const itemFolderPath = video.folderPath || '';

      // Check if already completed
      const outputDir = path.join(itemDownloadPath, itemFolderPath);
      const outputFile = path.join(outputDir, `${itemTitle}_${itemQuality}.mkv`);
      const progressFile = outputFile + '.progress';

      let isComplete = false;
      if (fs.existsSync(outputFile) && fs.existsSync(progressFile)) {
        try {
          const prog = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
          if (prog.complete) {
            isComplete = true;
          }
        } catch (e) {}
      }

      if (isComplete) {
        continue; // Skip adding to the queue entirely
      }

      const item = {
        id: video.id,
        title: itemTitle,
        folderPath: itemFolderPath,
        quality: itemQuality,
        downloadPath: itemDownloadPath,
        status: 'queued', // queued, downloading, complete, error, skipped, paused
        totalBytes: 0,
        downloadedBytes: 0,
        speed: 0,
        eta: '',
        error: null,
        startTime: null,
        addedAt: Date.now()
      };

      this.queue.push(item);
      addedCount++;
    }

    this.broadcastQueueUpdate();
    this.processQueue();
    return addedCount;
  }

  sanitizeFilename(name) {
    return name.replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/\.+$/, '').trim();
  }

  setMaxConcurrent(threads) {
    this.maxConcurrent = Math.max(1, Math.min(32, threads));
    this.processQueue();
  }

  getStatus() {
    return {
      queue: this.queue,
      stats: this.getStats()
    };
  }

  getStats() {
    const total = this.queue.length;
    const downloading = this.queue.filter(q => q.status === 'downloading').length;
    const completed = this.queue.filter(q => q.status === 'complete').length;
    const skipped = this.queue.filter(q => q.status === 'skipped').length;
    const errors = this.queue.filter(q => q.status === 'error').length;
    const totalBytes = this.queue.reduce((sum, q) => sum + (q.downloadedBytes || 0), 0);

    return { total, downloading, completed, skipped, errors, totalBytes };
  }

  pause() {
    this.paused = true;
    for (const item of this.queue) {
      if (item.status === 'downloading') {
        this.cancelDownload(item.id, 'paused');
      }
    }
  }

  resume() {
    this.paused = false;
    for (const item of this.queue) {
      if (item.status === 'paused') {
        item.status = 'queued';
      }
    }
    this.broadcastQueueUpdate();
    this.processQueue();
  }

  cancelDownload(videoId, targetStatus = 'queued') {
    const item = this.queue.find(q => q.id == videoId);
    if (item && item.status === 'downloading') {
      const abortState = this.abortControllers.get(videoId);
      if (abortState) abortState.aborted = true;

      const req = this.activeRequests.get(videoId);
      if (req) {
        try { req.destroy(); } catch (e) {}
      }

      item.status = targetStatus;
      item.speed = 0;
      item.eta = '';
      this.broadcastProgress(item);
    }
    this.broadcastQueueUpdate();
    this.processQueue();
  }

  clearCompleted() {
    this.queue = this.queue.filter(q => q.status !== 'complete' && q.status !== 'skipped');
    this.broadcastQueueUpdate();
  }

  /**
   * Process queue.
   */
  processQueue() {
    if (this.paused) return;

    const downloading = this.queue.filter(q => q.status === 'downloading').length;
    const available = this.maxConcurrent - downloading;

    if (available <= 0) return;

    const queued = this.queue.filter(q => q.status === 'queued');
    const toStart = queued.slice(0, available);

    for (const item of toStart) {
      this.downloadVideo(item);
    }
  }

  /**
   * AES Decryption helper (AES-128-CBC)
   */
  decrypt(encData, keyStr, ivStr) {
    const key = Buffer.from(keyStr, 'utf8');
    const iv = Buffer.from(ivStr, 'utf8');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    let dec = decipher.update(Buffer.from(encData, 'base64'));
    dec = Buffer.concat([dec, decipher.final()]);
    return dec.toString('utf8');
  }

  /**
   * XOR Decryption helper for the first 28 bytes
   */
  xorDecrypt(buffer, keyStr) {
    const n = Math.min(28, buffer.length);
    const result = Buffer.from(buffer);
    for (let a = 0; a < n; a++) {
      const s = buffer[a];
      const decryptedByte = a <= keyStr.length - 1 ? s ^ keyStr.charCodeAt(a) : s ^ a;
      result[a] = decryptedByte;
    }
    return result;
  }

  /**
   * Core download task
   */
  async downloadVideo(item) {
    const outputDir = path.join(item.downloadPath, item.folderPath);
    const outputFile = path.join(outputDir, `${item.title}_${item.quality}.mkv`);
    const progressFile = outputFile + '.progress';

    // Check if complete before any API calls
    if (fs.existsSync(outputFile) && fs.existsSync(progressFile)) {
      try {
        const prog = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        if (prog.complete) {
          console.log(`[DOWNLOAD] Video ID ${item.id} already completed. Skipping API fetch.`);
          item.status = 'skipped';
          item.totalBytes = prog.totalBytes;
          item.downloadedBytes = prog.totalBytes;
          this.broadcastProgress(item);
          this.broadcastQueueUpdate();
          this.processQueue();
          return;
        }
      } catch (e) {}
    }

    const retries = 5;
    let attempt = 0;

    while (attempt < retries) {
      attempt++;
      item.status = 'downloading';
      item.startTime = Date.now();
      item.error = null;
      this.abortControllers.set(item.id, { aborted: false });
      this.broadcastProgress(item);

      let inactivityTimer = null;

      try {
        if (!this.apiGet) {
          throw new Error('API helper not configured on Downloader');
        }

        console.log(`[DOWNLOAD] Fetching details for Video ID: ${item.id} (Attempt ${attempt}/${retries})`);
        const details = await this.apiGet(`/get/fetchVideoDetailsById?course_id=110&video_id=${item.id}&ytflag=0&folder_wise_course=1&lc_app_api_url=`);
        if (!details || details.status !== 200 || !details.data) {
          throw new Error(details?.message || 'Failed to fetch video details from API');
        }

        const videoData = details.data;
        if (!videoData.encrypted_links || videoData.encrypted_links.length === 0) {
          throw new Error('No encrypted download links found in video details');
        }

        // Find selected quality link
        let selectedLink = videoData.encrypted_links.find(l => l.quality === item.quality);
        if (!selectedLink) {
          selectedLink = videoData.encrypted_links[0]; // fallback
          item.quality = selectedLink.quality || 'unknown';
        }

        console.log(`[DOWNLOAD] Decrypting CDN link for quality: ${item.quality}`);
        const VALUE = '638udh3829162018';
        const SALT = 'fedcba9876543210';

        const rawPath = selectedLink.path.split(':')[0];
        const decryptedUrl = this.decrypt(rawPath, VALUE, SALT);

        const rawKey = selectedLink.key.split(':')[0];
        const decryptedKeyBase64 = this.decrypt(rawKey, VALUE, SALT);
        const xorKeyString = Buffer.from(decryptedKeyBase64, 'base64').toString('utf8');
        
        console.log(`[DOWNLOAD] Decrypted CDN URL: ${decryptedUrl.substring(0, 100)}...`);
        console.log(`[DOWNLOAD] XOR Decryption Key: ${xorKeyString}`);

        fs.mkdirSync(outputDir, { recursive: true });

        // Check file size for resume
        let currentSize = 0;
        if (fs.existsSync(outputFile)) {
          currentSize = fs.statSync(outputFile).size;
        }

        // Start HTTP Request
        const cdnHeaders = {
          ...this.apiHeaders,
          'accept-encoding': 'identity',
          'connection': 'keep-alive'
        };
        if (currentSize > 0) {
          cdnHeaders['range'] = `bytes=${currentSize}-`;
          console.log(`[DOWNLOAD] Resuming download from byte: ${currentSize}`);
        }

        await new Promise((resolve, reject) => {
          const parsedUrl = new URL(decryptedUrl);
          const reqOpts = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: cdnHeaders,
            rejectUnauthorized: false
          };

          let lastChunkTime = Date.now();
          inactivityTimer = setInterval(() => {
            if (Date.now() - lastChunkTime > 25000) { // 25 seconds of silence
              cleanup();
              console.error(`[DOWNLOAD] Inactivity timeout (25s) on Video ID ${item.id}`);
              req.destroy(new Error('Connection hung (inactivity for 25s)'));
            }
          }, 5000);

          const cleanup = () => {
            if (inactivityTimer) {
              clearInterval(inactivityTimer);
              inactivityTimer = null;
            }
          };

          const req = https.get(reqOpts, (res) => {
            this.activeRequests.set(item.id, req);

            if (res.statusCode === 416) {
              console.log(`[DOWNLOAD] File already complete (HTTP 416)`);
              fs.writeFileSync(progressFile, JSON.stringify({ complete: true, totalBytes: currentSize }));
              cleanup();
              resolve();
              return;
            }

            if (res.statusCode !== 200 && res.statusCode !== 206) {
              cleanup();
              return reject(new Error(`CDN returned HTTP ${res.statusCode}`));
            }

            if (res.statusCode === 200) {
              currentSize = 0;
            }

            const totalContentLength = parseInt(res.headers['content-length'] || '0');
            item.totalBytes = totalContentLength + currentSize;
            item.downloadedBytes = currentSize;

            const writeStream = fs.createWriteStream(outputFile, { flags: currentSize > 0 ? 'r+' : 'w', start: currentSize });

            let isFirstChunk = true;
            let bytesWrittenSession = 0;
            const sessionStart = Date.now();
            let lastUpdate = Date.now();

            res.on('data', (chunk) => {
              lastChunkTime = Date.now(); // Reset inactivity timer
              
              if (this.abortControllers.get(item.id)?.aborted) {
                cleanup();
                writeStream.end();
                res.destroy();
                reject(new Error('Aborted'));
                return;
              }

              let writeBuffer = chunk;

              if (currentSize === 0 && isFirstChunk) {
                isFirstChunk = false;
                writeBuffer = this.xorDecrypt(chunk, xorKeyString);
              }

              writeStream.write(writeBuffer);
              bytesWrittenSession += chunk.length;
              item.downloadedBytes = currentSize + bytesWrittenSession;

              const now = Date.now();
              if (now - lastUpdate > 500) {
                const elapsed = (now - sessionStart) / 1000;
                item.speed = elapsed > 0 ? bytesWrittenSession / elapsed : 0;
                const remainingBytes = item.totalBytes - item.downloadedBytes;
                item.eta = remainingBytes > 0 && item.speed > 0
                  ? this.formatTime(remainingBytes / item.speed)
                  : '';
                
                this.broadcastProgress(item);
                lastUpdate = now;
              }
            });

            res.on('end', () => {
              cleanup();
              writeStream.end(() => {
                if (item.downloadedBytes >= item.totalBytes) {
                  fs.writeFileSync(progressFile, JSON.stringify({ complete: true, totalBytes: item.totalBytes }));
                  resolve();
                } else {
                  reject(new Error(`Stream ended early: ${item.downloadedBytes}/${item.totalBytes} bytes downloaded`));
                }
              });
            });

            res.on('error', (err) => {
              cleanup();
              writeStream.end();
              reject(err);
            });
          });

          req.on('error', (err) => {
            cleanup();
            reject(err);
          });

          // Inactivity socket timeout
          req.setTimeout(25000, () => {
            cleanup();
            console.error(`[DOWNLOAD] Socket timeout (25s) on Video ID ${item.id}`);
            req.destroy(new Error('Socket timeout (25s)'));
          });
        });

        // Complete!
        item.status = 'complete';
        item.speed = 0;
        item.eta = '';
        this.broadcastProgress(item);
        this.wsBroadcast({ type: 'complete', videoId: item.id });
        break; // break retry loop on success
        
      } catch (err) {
        if (inactivityTimer) {
          clearInterval(inactivityTimer);
          inactivityTimer = null;
        }

        if (this.abortControllers.get(item.id)?.aborted) {
          item.status = 'paused';
          console.log(`[DOWNLOAD] Video download paused: ${item.title}`);
          break; // break retry loop if paused
        }

        console.error(`[DOWNLOAD] Error on attempt ${attempt} for Video ID ${item.id}: ${err.message}`);
        
        if (attempt >= retries) {
          item.status = 'error';
          item.error = err.message;
          this.broadcastProgress(item);
          this.wsBroadcast({ type: 'error', videoId: item.id, message: err.message });
          break;
        }

        // Retry wait with linear backoff (2s * attempt)
        console.log(`[DOWNLOAD] Retrying Video ID ${item.id} in ${2 * attempt}s...`);
        item.status = 'queued';
        item.speed = 0;
        item.eta = 'Retrying...';
        this.broadcastProgress(item);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      } finally {
        this.abortControllers.delete(item.id);
        this.activeRequests.delete(item.id);
      }
    }

    this.broadcastQueueUpdate();
    this.processQueue();
  }

  formatTime(seconds) {
    if (isNaN(seconds) || seconds === Infinity) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
  }

  broadcastProgress(item) {
    this.wsBroadcast({
      type: 'progress',
      videoId: item.id,
      status: item.status,
      downloaded: item.downloadedBytes,
      total: item.totalBytes,
      downloadedBytes: item.downloadedBytes,
      speed: item.speed,
      eta: item.eta,
      error: item.error
    });
  }

  broadcastQueueUpdate() {
    this.wsBroadcast({
      type: 'queue_update',
      queue: this.queue,
      stats: this.getStats()
    });
  }

  /**
   * Dummy compatibility methods
   */
  parseCdnUrl(url) {
    return {
      segBase: 'mkv',
      vidBase: 'mkv',
      quality: '480p',
      token: '',
      buildUrl: () => url
    };
  }
}

module.exports = DownloadManager;
