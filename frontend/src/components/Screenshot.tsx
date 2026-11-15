import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch, buildApiUrl } from '../api';
import { Modal } from './Modal';
import { Icon } from './Icon';

declare const window: Window & {
  go?: {
    main: {
      App: {
        GetImageBase64: (path: string) => Promise<string>;
        GetThumbnailBase64?: (path: string) => Promise<string>;
      };
    };
  };
};

/**
 * Robust LRU cache that revokes any underlying Blob URLs upon eviction or deletion.
 */
class ImageLRUCache {
  private map = new Map<string, string>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): string | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Refresh recency
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, val: string): void {
    if (this.map.has(key)) {
      const oldVal = this.map.get(key);
      if (oldVal && oldVal.startsWith('blob:') && oldVal !== val) {
        URL.revokeObjectURL(oldVal);
      }
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey) {
        const oldestVal = this.map.get(oldestKey);
        if (oldestVal && oldestVal.startsWith('blob:')) {
          URL.revokeObjectURL(oldestVal);
        }
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, val);
  }

  delete(key: string): boolean {
    const val = this.map.get(key);
    if (val && val.startsWith('blob:')) {
      URL.revokeObjectURL(val);
    }
    return this.map.delete(key);
  }

  clear(): void {
    for (const val of this.map.values()) {
      if (val && val.startsWith('blob:')) {
        URL.revokeObjectURL(val);
      }
    }
    this.map.clear();
  }
}

// 20 full-size screenshots (prevents gigabyte RAM bloat) and 80 list thumbnails
const imageMemoryCache = new ImageLRUCache(20);
const thumbMemoryCache = new ImageLRUCache(80);

const pendingRequests = new Map<string, Promise<string | null>>();
const pendingThumbRequests = new Map<string, Promise<string | null>>();

export function clearImageMemoryCaches(): void {
  imageMemoryCache.clear();
  thumbMemoryCache.clear();
}

// Concurrency limiter for IPC thumbnail reads
const MAX_CONCURRENT_THUMBS = 3;
let activeThumbRequests = 0;
const thumbQueue: Array<() => void> = [];

function acquireThumbSlot(): Promise<void> {
  if (activeThumbRequests < MAX_CONCURRENT_THUMBS) {
    activeThumbRequests += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    thumbQueue.push(() => {
      activeThumbRequests += 1;
      resolve();
    });
  });
}

function releaseThumbSlot(): void {
  activeThumbRequests = Math.max(0, activeThumbRequests - 1);
  const next = thumbQueue.shift();
  if (next) next();
}

/** Check if the path is already a standalone data URL, blob, or absolute web URL */
export function isDirectImageUrl(path: string): boolean {
  return /^(data:|blob:|https?:\/\/)/i.test(path);
}

/** Build an environment-aware API URL for image access */
export function buildImageUrl(imagePath: string): string {
  if (!imagePath) return '';
  if (isDirectImageUrl(imagePath)) return imagePath;
  if (imagePath.startsWith('/api/')) return buildApiUrl(imagePath);
  return buildApiUrl(`/api/image?path=${encodeURIComponent(imagePath)}`);
}

/** Fetch image data via authenticated HTTP and return a Blob Object URL */
async function loadHttpImageBlob(url: string): Promise<string | null> {
  try {
    const res = await apiFetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob || blob.size === 0) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/**
 * Fetch full-resolution screenshot data:
 * 1. Cache hit (LRU refreshed).
 * 2. Desktop Wails bridge if available.
 * 3. Authenticated HTTP fallback with Blob URL.
 */
export function fetchImageData(imagePath: string): Promise<string | null> {
  if (!imagePath) return Promise.resolve(null);
  if (isDirectImageUrl(imagePath)) return Promise.resolve(imagePath);

  if (imageMemoryCache.has(imagePath)) {
    return Promise.resolve(imageMemoryCache.get(imagePath)!);
  }

  if (pendingRequests.has(imagePath)) {
    return pendingRequests.get(imagePath)!;
  }

  const promise = (async () => {
    try {
      // 1. Desktop Wails IPC
      if (window.go?.main?.App?.GetImageBase64) {
        try {
          const res = await window.go.main.App.GetImageBase64(imagePath);
          if (res) {
            imageMemoryCache.set(imagePath, res);
            return res;
          }
        } catch {
          // Fall through to HTTP server fallback (e.g. server-synced capture)
        }
      }

      // 2. HTTP Server fallback via authenticated apiFetch
      const url = buildImageUrl(imagePath);
      const blobUrl = await loadHttpImageBlob(url);
      if (blobUrl) {
        imageMemoryCache.set(imagePath, blobUrl);
        return blobUrl;
      }
    } catch {
      // Ignore load errors
    } finally {
      pendingRequests.delete(imagePath);
    }
    return null;
  })();

  pendingRequests.set(imagePath, promise);
  return promise;
}

/**
 * Fetch thumbnail preview data:
 * Uses fast downscaled Go WebP thumbnail when available, falling back to HTTP blob or full image.
 */
export function fetchThumbData(imagePath: string): Promise<string | null> {
  if (!imagePath) return Promise.resolve(null);
  if (isDirectImageUrl(imagePath)) return Promise.resolve(imagePath);

  if (thumbMemoryCache.has(imagePath)) {
    return Promise.resolve(thumbMemoryCache.get(imagePath)!);
  }

  if (pendingThumbRequests.has(imagePath)) {
    return pendingThumbRequests.get(imagePath)!;
  }

  const promise = (async () => {
    try {
      const goApp = (window as any).go?.main?.App;
      if (goApp?.GetThumbnailBase64) {
        await acquireThumbSlot();
        let res: string | null = null;
        try {
          res = await goApp.GetThumbnailBase64(imagePath);
        } finally {
          releaseThumbSlot();
        }
        if (res) {
          thumbMemoryCache.set(imagePath, res);
          return res;
        }
      }

      // In web mode, load via authenticated HTTP
      if (!goApp) {
        const url = buildImageUrl(imagePath);
        const blobUrl = await loadHttpImageBlob(url);
        if (blobUrl) {
          thumbMemoryCache.set(imagePath, blobUrl);
          return blobUrl;
        }
      }
    } catch {
      // fall through
    }

    // Fallback to full image loader
    return fetchImageData(imagePath);
  })();

  const clearPendingThumb = () => { pendingThumbRequests.delete(imagePath); };
  promise.then(clearPendingThumb, clearPendingThumb);

  pendingThumbRequests.set(imagePath, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Thumbnail Component
// ---------------------------------------------------------------------------

interface ThumbProps {
  imagePath?: string;
  onClick?: () => void;
  className?: string;
}

export function ScreenshotThumb({ imagePath, onClick, className }: ThumbProps) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  const [src, setSrc] = useState<string | null>(() => {
    return imagePath && thumbMemoryCache.has(imagePath) ? thumbMemoryCache.get(imagePath)! : null;
  });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!node || inView) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, inView]);

  useEffect(() => {
    if (!imagePath) {
      setSrc(null);
      setLoading(false);
      setFailed(false);
      return;
    }

    if (thumbMemoryCache.has(imagePath)) {
      setSrc(thumbMemoryCache.get(imagePath)!);
      setLoading(false);
      setFailed(false);
      return;
    }

    if (!inView) {
      setSrc(null);
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setFailed(false);

    fetchThumbData(imagePath).then((data) => {
      if (isMounted) {
        setSrc(data);
        setLoading(false);
        setFailed(!data);
      }
    });

    return () => { isMounted = false; };
  }, [imagePath, inView]);

  if (loading && !src) {
    return (
      <div
        ref={setNode}
        className="timeline-thumb-placeholder skeleton"
        role="status"
        aria-label="Loading screenshot preview"
      >
        <Icon name="desktop" size={16} color="var(--text-muted)" />
      </div>
    );
  }

  if (!src) {
    return (
      <div
        ref={setNode}
        className={`timeline-thumb-placeholder${failed ? ' thumb-failed' : ''}`}
        title={failed ? 'Failed to load screenshot (click to retry)' : 'No screenshot captured'}
        role="img"
        aria-label={failed ? 'Failed to load screenshot' : 'No screenshot captured'}
        onClick={failed && imagePath ? () => {
          thumbMemoryCache.delete(imagePath);
          setFailed(false);
          setLoading(true);
          fetchThumbData(imagePath).then((d) => {
            setSrc(d);
            setLoading(false);
            setFailed(!d);
          });
        } : undefined}
        style={{ cursor: failed ? 'pointer' : 'default' }}
      >
        <Icon
          name={failed ? 'info' : 'desktop'}
          size={16}
          color={failed ? 'var(--accent-amber)' : 'var(--text-muted)'}
        />
      </div>
    );
  }

  const thumbClassName = `${className ? `${className} ` : ''}timeline-thumb-img`;

  // Avoid creating a tab-stop button if not clickable
  if (!onClick) {
    return (
      <div ref={setNode} className={thumbClassName} role="img" aria-label="Screenshot preview">
        <img
          src={src}
          alt="Desktop capture preview"
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: 'inherit',
          }}
          onError={() => {
            if (imagePath) thumbMemoryCache.delete(imagePath);
            setSrc(null);
            setFailed(true);
          }}
        />
      </div>
    );
  }

  return (
    <button
      ref={setNode}
      type="button"
      onClick={onClick}
      className={thumbClassName}
      style={{
        padding: 0,
        appearance: 'none',
        cursor: 'pointer',
      }}
      aria-label="Inspect screenshot capture"
    >
      <img
        src={src}
        alt="Desktop capture preview"
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          borderRadius: 'inherit',
        }}
        onError={() => {
          if (imagePath) thumbMemoryCache.delete(imagePath);
          setSrc(null);
          setFailed(true);
        }}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// ImageModal Lightbox Component (Zoom + Pan + A11y)
// ---------------------------------------------------------------------------

interface ImageModalProps {
  imagePath: string | null;
  onClose: () => void;
}

export function ImageModal({ imagePath, onClose }: ImageModalProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number }>({ x: 0, y: 0, panX: 0, panY: 0 });

  const resetTransform = useCallback(() => {
    setZoomScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleZoomIn = useCallback(() => {
    setZoomScale((prev) => Math.min(3, parseFloat((prev + 0.25).toFixed(2))));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomScale((prev) => {
      const next = Math.max(0.5, parseFloat((prev - 0.25).toFixed(2)));
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  // Load image on modal open
  useEffect(() => {
    if (!imagePath) {
      setSrc(null);
      setLoading(false);
      resetTransform();
      return;
    }

    resetTransform();

    if (imageMemoryCache.has(imagePath)) {
      setSrc(imageMemoryCache.get(imagePath)!);
      setLoading(false);
      return;
    }

    setSrc(null);
    setLoading(true);
    let isMounted = true;

    fetchImageData(imagePath).then((data) => {
      if (isMounted) {
        setSrc(data);
        setLoading(false);
      }
    });

    return () => { isMounted = false; };
  }, [imagePath, resetTransform]);

  // Non-intrusive keyboard shortcuts (no browser shortcut hijacking)
  useEffect(() => {
    if (!imagePath) return;

    const handleZoomKeyDown = (e: KeyboardEvent) => {
      // Do not hijack browser zoom (Ctrl/Cmd) or form inputs
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        handleZoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        resetTransform();
      } else if (zoomScale > 1) {
        // Pan via Arrow Keys
        const step = 40;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setPan((p) => ({ ...p, x: p.x + step }));
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          setPan((p) => ({ ...p, x: p.x - step }));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setPan((p) => ({ ...p, y: p.y + step }));
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setPan((p) => ({ ...p, y: p.y - step }));
        }
      }
    };

    window.addEventListener('keydown', handleZoomKeyDown);
    return () => window.removeEventListener('keydown', handleZoomKeyDown);
  }, [imagePath, handleZoomIn, handleZoomOut, resetTransform, zoomScale]);

  // Mouse pan drag handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoomScale <= 1 || e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || zoomScale <= 1) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({
      x: dragStartRef.current.panX + dx,
      y: dragStartRef.current.panY + dy,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleDoubleClick = () => {
    if (zoomScale > 1) {
      resetTransform();
    } else {
      setZoomScale(2);
    }
  };

  const zoomControls = imagePath ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} role="toolbar" aria-label="Zoom controls">
      <button
        onClick={handleZoomOut}
        disabled={zoomScale <= 0.5}
        className="btn btn-secondary btn-sm"
        title="Zoom Out (- or _)"
        aria-label="Zoom out"
        style={{
          height: 28,
          padding: '0 8px',
          display: 'inline-flex',
          alignItems: 'center',
          opacity: zoomScale <= 0.5 ? 0.6 : undefined,
          cursor: zoomScale <= 0.5 ? 'not-allowed' : undefined,
        }}
      >
        <Icon name="minus" size={14} />
      </button>
      <button
        onClick={resetTransform}
        className="btn btn-secondary btn-sm"
        title="Reset Zoom (0 key)"
        aria-label="Reset zoom to 100%"
        style={{ height: 28, padding: '0 8px', fontSize: 11, fontFamily: 'monospace' }}
      >
        {Math.round(zoomScale * 100)}%
      </button>
      <button
        onClick={handleZoomIn}
        disabled={zoomScale >= 3}
        className="btn btn-secondary btn-sm"
        title="Zoom In (+ or =)"
        aria-label="Zoom in"
        style={{
          height: 28,
          padding: '0 8px',
          display: 'inline-flex',
          alignItems: 'center',
          opacity: zoomScale >= 3 ? 0.6 : undefined,
          cursor: zoomScale >= 3 ? 'not-allowed' : undefined,
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  ) : null;

  return (
    <Modal
      isOpen={Boolean(imagePath)}
      onClose={onClose}
      icon={<Icon name="desktop" size={18} color="var(--accent-primary)" />}
      title="Desktop Screenshot Inspection"
      description="Full-resolution capture from the tracked display."
      actions={zoomControls}
      maxWidth={1060}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, width: '100%' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Keyboard: <kbd className="kbd-shortcut">+</kbd>/<kbd className="kbd-shortcut">-</kbd> zoom, <kbd className="kbd-shortcut">0</kbd> reset, <kbd className="kbd-shortcut">Arrows</kbd> pan, <kbd className="kbd-shortcut">Esc</kbd> close
          </span>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-primary btn-sm"
          >
            Close Inspection
          </button>
        </div>
      }
    >
      <div
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        style={{
          overflow: 'hidden',
          height: 'clamp(200px, calc(100vh - 260px), 78vh)',
          maxHeight: '78vh',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-base)',
          padding: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          cursor: zoomScale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
          userSelect: 'none',
        }}
      >
        {loading ? (
          <div style={{ margin: 'auto', padding: '60px 100px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <Icon name="refresh" size={24} className="spin" color="var(--accent-primary)" />
            <span>Loading full-resolution screenshot...</span>
          </div>
        ) : src ? (
          <img
            src={src}
            alt="Desktop Screenshot Inspection"
            draggable={false}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 'var(--radius-sm)',
              display: 'block',
              border: '1px solid var(--border-subtle)',
              boxShadow: 'var(--shadow-card)',
              imageRendering: '-webkit-optimize-contrast',
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoomScale})`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.15s ease-out',
            }}
            onError={() => {
              if (imagePath) imageMemoryCache.delete(imagePath);
              setSrc(null);
            }}
          />
        ) : (
          <div style={{ margin: 'auto', padding: '40px 60px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <Icon name="info" size={28} color="var(--accent-amber)" />
            <span>Failed to load screenshot image</span>
            {imagePath && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  imageMemoryCache.delete(imagePath);
                  setLoading(true);
                  fetchImageData(imagePath).then((d) => {
                    setSrc(d);
                    setLoading(false);
                  });
                }}
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      {imagePath && (
        <div style={{ marginTop: 10, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)', textAlign: 'center', wordBreak: 'break-all' }}>
          {imagePath}
        </div>
      )}
    </Modal>
  );
}
